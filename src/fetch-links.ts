import { createHash } from 'node:crypto';
import { extractText, getDocumentProxy } from 'unpdf';
import type { Database } from './db.js';

// ── Types ────────────────────────────────────────────────────────────────

export type LinkContentType = 'github_readme' | 'github_gist' | 'article';

export interface ClassifiedUrl {
  type: LinkContentType;
  owner?: string;
  repo?: string;
  gistId?: string;
}

export interface FetchedContent {
  title: string;
  content: string;
  resolvedUrl?: string;
}

interface FetchContentOutcome {
  fetchedContent: FetchedContent | null;
  failure?: string;
  retryable: boolean;
}

// ── URL classification ───────────────────────────────────────────────────

export function classifyUrl(url: string): ClassifiedUrl | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    // GitHub Gist: gist.github.com/{owner}/{id}
    if (host === 'gist.github.com' && pathParts.length >= 2) {
      return { type: 'github_gist', owner: pathParts[0], gistId: pathParts[1] };
    }

    // GitHub repo: github.com/{owner}/{repo}
    if (host === 'github.com' && pathParts.length >= 2) {
      // Skip non-repo pages
      const nonRepoFirstSegments = ['settings', 'marketplace', 'explore', 'topics', 'trending', 'collections', 'events', 'sponsors', 'login', 'signup', 'features', 'enterprise', 'pricing', 'about'];
      if (nonRepoFirstSegments.includes(pathParts[0].toLowerCase())) return { type: 'article' };

      return {
        type: 'github_readme',
        owner: pathParts[0],
        repo: pathParts[1].replace(/\.git$/, ''),
      };
    }

    // Everything else is an article
    return { type: 'article' };
  } catch {
    return null;
  }
}

// ── GitHub fetchers ──────────────────────────────────────────────────────

interface RateLimitState {
  remaining: number;
  resetAt: number;
}

let githubRateLimit: RateLimitState = { remaining: Infinity, resetAt: 0 };

function updateRateLimit(headers: Headers): void {
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (remaining != null) githubRateLimit.remaining = Number(remaining);
  if (reset != null) githubRateLimit.resetAt = Number(reset) * 1000;
}

function isRateLimited(): boolean {
  return githubRateLimit.remaining <= 1 && Date.now() < githubRateLimit.resetAt;
}

function githubHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github.v3.raw',
    'User-Agent': 'fieldtheory-cli',
  };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

async function fetchGithubReadme(owner: string, repo: string, token?: string): Promise<FetchContentOutcome> {
  if (isRateLimited()) {
    return { fetchedContent: null, failure: 'github_rate_limited', retryable: true };
  }

  // Try GitHub API (returns raw markdown with the Accept header)
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  try {
    const res = await fetch(apiUrl, { headers: githubHeaders(token) });
    updateRateLimit(res.headers);

    if (res.ok) {
      const content = await res.text();
      return {
        fetchedContent: {
          title: `${owner}/${repo} README`,
          content: content.slice(0, 500_000), // cap at 500KB
          resolvedUrl: apiUrl,
        },
        retryable: false,
      };
    }

    if (res.status === 401) {
      return { fetchedContent: null, failure: 'github_unauthorized', retryable: false };
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
      if (res.status === 429 || (!Number.isNaN(remaining) && remaining <= 1)) {
        return { fetchedContent: null, failure: 'github_rate_limited', retryable: true };
      }
      return {
        fetchedContent: null,
        failure: token ? 'github_forbidden' : 'github_forbidden_or_token_missing',
        retryable: false,
      };
    }
    if (res.status >= 500) {
      return { fetchedContent: null, failure: 'github_api_error', retryable: true };
    }
    // 404 = no README or unavailable via API, try raw fallback
  } catch {
    // Try raw fallback after transient API failure.
  }

  // Fallback: raw.githubusercontent.com
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`;
  try {
    const res = await fetch(rawUrl, { headers: { 'User-Agent': 'fieldtheory-cli' } });
    if (res.ok) {
      const content = await res.text();
      return {
        fetchedContent: {
          title: `${owner}/${repo} README`,
          content: content.slice(0, 500_000),
          resolvedUrl: rawUrl,
        },
        retryable: false,
      };
    }
    if (res.status === 404) {
      return { fetchedContent: null, failure: 'github_readme_missing', retryable: false };
    }
    if (res.status >= 500) {
      return { fetchedContent: null, failure: 'github_raw_error', retryable: true };
    }
    if (res.status === 403) {
      return {
        fetchedContent: null,
        failure: token ? 'github_forbidden' : 'github_forbidden_or_token_missing',
        retryable: false,
      };
    }
  } catch {
    return { fetchedContent: null, failure: 'github_readme_fetch_failed', retryable: true };
  }

  return { fetchedContent: null, failure: 'github_readme_unavailable', retryable: false };
}

async function fetchGithubGist(gistId: string, token?: string): Promise<FetchContentOutcome> {
  if (isRateLimited()) {
    return { fetchedContent: null, failure: 'github_rate_limited', retryable: true };
  }

  const apiUrl = `https://api.github.com/gists/${gistId}`;
  try {
    const res = await fetch(apiUrl, {
      headers: {
        ...githubHeaders(token),
        'Accept': 'application/vnd.github.v3+json',
      },
    });
    updateRateLimit(res.headers);

    if (!res.ok) {
      if (res.status === 401) {
        return { fetchedContent: null, failure: 'github_unauthorized', retryable: false };
      }
      if (res.status === 403 || res.status === 429) {
        const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
        if (res.status === 429 || (!Number.isNaN(remaining) && remaining <= 1)) {
          return { fetchedContent: null, failure: 'github_rate_limited', retryable: true };
        }
        return {
          fetchedContent: null,
          failure: token ? 'github_forbidden' : 'github_forbidden_or_token_missing',
          retryable: false,
        };
      }
      if (res.status === 404) {
        return { fetchedContent: null, failure: 'github_gist_not_found', retryable: false };
      }
      if (res.status >= 500) {
        // API may choke on large/popular gists — try raw fallback
        const fallback = await fetchGithubGistRaw(gistId);
        if (fallback) return { fetchedContent: fallback, retryable: false };
        return { fetchedContent: null, failure: 'github_gist_api_error', retryable: true };
      }
      return { fetchedContent: null, failure: 'github_gist_unavailable', retryable: false };
    }

    const data = await res.json() as {
      description?: string;
      files?: Record<string, { filename?: string; content?: string }>;
    };
    const files = Object.values(data.files ?? {});
    if (files.length === 0) {
      return { fetchedContent: null, failure: 'github_gist_empty', retryable: false };
    }

    const content = files
      .map((f) => `--- ${f.filename ?? 'untitled'} ---\n${f.content ?? ''}`)
      .join('\n\n');

    return {
      fetchedContent: {
        title: data.description || files[0]?.filename || `Gist ${gistId}`,
        content: content.slice(0, 500_000),
        resolvedUrl: `https://gist.github.com/${gistId}`,
      },
      retryable: false,
    };
  } catch {
    // Network failure — try raw fallback before giving up
    const fallback = await fetchGithubGistRaw(gistId);
    if (fallback) return { fetchedContent: fallback, retryable: false };
    return { fetchedContent: null, failure: 'github_gist_fetch_failed', retryable: true };
  }
}

async function fetchGithubGistRaw(gistId: string): Promise<FetchedContent | null> {
  try {
    const rawUrl = `https://gist.githubusercontent.com/${gistId}/raw`;
    const res = await fetch(rawUrl, {
      headers: { 'User-Agent': 'fieldtheory-cli' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const content = await res.text();
    if (content.length < 10) return null;

    return {
      title: `Gist ${gistId.slice(0, 8)}`,
      content: content.slice(0, 500_000),
      resolvedUrl: `https://gist.github.com/${gistId}`,
    };
  } catch {
    return null;
  }
}

// ── Article fetcher ──────────────────────────────────────────────────────

async function fetchArticle(url: string): Promise<FetchedContent | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'fieldtheory-cli' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') ?? '';

    if (contentType.includes('application/pdf')) {
      return await extractPdfContent(res, url);
    }

    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/json')) {
      return null;
    }

    const html = await res.text();
    if (html.length < 100) return null;

    const title = extractTitle(html);
    const content = extractReadableText(html);
    if (content.length < 50) return null;

    return {
      title: title || new URL(url).hostname,
      content: content.slice(0, 500_000),
      resolvedUrl: res.url !== url ? res.url : undefined,
    };
  } catch {
    return null;
  }
}

const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB

async function extractPdfContent(res: Response, url: string): Promise<FetchedContent | null> {
  try {
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength > MAX_PDF_BYTES) return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_PDF_BYTES) return null;

    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });

    const content = (text as string).trim();
    if (content.length < 50) return null;

    // Try to extract title from first line of PDF text
    const firstLine = content.split('\n').find(l => l.trim().length > 5)?.trim() ?? '';
    const title = firstLine.length > 10 && firstLine.length < 300 ? firstLine : new URL(url).hostname;

    return {
      title,
      content: content.slice(0, 500_000),
      resolvedUrl: res.url !== url ? res.url : undefined,
    };
  } catch {
    return null;
  }
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

function extractReadableText(html: string): string {
  // Remove script, style, nav, footer, header, aside
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');

  // Try to extract from article or main tags first
  const articleMatch = text.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  const mainMatch = text.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
  if (articleMatch) text = articleMatch[1];
  else if (mainMatch) text = mainMatch[1];

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

// ── DB helpers ───────────────────────────────────────────────────────────

function contentId(bookmarkId: string, sourceUrl: string): string {
  return createHash('sha256').update(`${bookmarkId}::${sourceUrl}`).digest('hex').slice(0, 16);
}

export function ensureLinkContentSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS link_content (
    id TEXT PRIMARY KEY,
    bookmark_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    resolved_url TEXT,
    content_type TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    content_bytes INTEGER,
    fetched_at TEXT NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_link_content_bookmark ON link_content(bookmark_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_link_content_type ON link_content(content_type)`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS link_content_fts USING fts5(
    title, content,
    content=link_content, content_rowid=rowid,
    tokenize='porter unicode61'
  )`);
  db.run(`CREATE TRIGGER IF NOT EXISTS link_content_ai AFTER INSERT ON link_content BEGIN
    INSERT INTO link_content_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS link_content_ad AFTER DELETE ON link_content BEGIN
    INSERT INTO link_content_fts(link_content_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.title, old.content);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS link_content_au AFTER UPDATE ON link_content BEGIN
    INSERT INTO link_content_fts(link_content_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.title, old.content);
    INSERT INTO link_content_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
  END`);
}

export function insertLinkContent(
  db: Database,
  id: string,
  bookmarkId: string,
  sourceUrl: string,
  resolvedUrl: string | undefined,
  type: LinkContentType,
  title: string,
  content: string,
  fetchedAt: string,
): void {
  db.run(
    `INSERT OR REPLACE INTO link_content VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, bookmarkId, sourceUrl, resolvedUrl ?? null, type, title, content, content.length, fetchedAt],
  );
}

export async function fetchLinkContentByUrl(
  url: string,
  opts: { githubToken?: string; githubOnly?: boolean } = {},
): Promise<{
  classified: ClassifiedUrl | null;
  fetchedContent: FetchedContent | null;
  retryable: boolean;
  failure?: string;
}> {
  const classified = classifyUrl(url);
  if (!classified) {
    return { classified: null, fetchedContent: null, retryable: false, failure: 'unparseable_url' };
  }
  if (opts.githubOnly && classified.type === 'article') {
    return { classified, fetchedContent: null, retryable: false, failure: 'github_only_skip' };
  }

  try {
    let fetchedContent: FetchedContent | null = null;
    let failure: string | undefined;
    let retryable = false;

    if (classified.type === 'github_readme' && classified.owner && classified.repo) {
      if (isRateLimited()) {
        return { classified, fetchedContent: null, retryable: true, failure: 'github_rate_limited' };
      }
      const outcome = await fetchGithubReadme(classified.owner, classified.repo, opts.githubToken);
      fetchedContent = outcome.fetchedContent;
      failure = outcome.failure;
      retryable = outcome.retryable;
    } else if (classified.type === 'github_gist' && classified.gistId) {
      if (isRateLimited()) {
        return { classified, fetchedContent: null, retryable: true, failure: 'github_rate_limited' };
      }
      const outcome = await fetchGithubGist(classified.gistId, opts.githubToken);
      fetchedContent = outcome.fetchedContent;
      failure = outcome.failure;
      retryable = outcome.retryable;
    } else if (classified.type === 'article') {
      fetchedContent = await fetchArticle(url);
    }

    if (fetchedContent) {
      return { classified, fetchedContent, retryable: false };
    }

    const terminal = classified.type === 'article';
    return {
      classified,
      fetchedContent: null,
      retryable: terminal ? false : retryable,
      failure: terminal ? 'unreadable_article' : (failure ?? 'content_unavailable'),
    };
  } catch (error) {
    return {
      classified,
      fetchedContent: null,
      retryable: true,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

export { contentId };
