import { createHash } from 'node:crypto';
import { openDb, saveDb } from './db.js';
import { twitterBookmarksIndexPath, ensureDataDir } from './paths.js';
import type { Database } from 'sql.js';

// ── Types ────────────────────────────────────────────────────────────────

export type LinkContentType = 'github_readme' | 'github_gist' | 'article';

interface ClassifiedUrl {
  type: LinkContentType;
  owner?: string;
  repo?: string;
  gistId?: string;
}

interface FetchedContent {
  title: string;
  content: string;
  resolvedUrl?: string;
}

export interface LinkFetchProgress {
  processed: number;
  total: number;
  fetched: number;
  running: boolean;
  done: boolean;
}

export interface LinkFetchResult {
  processed: number;
  fetched: number;
  failed: number;
  rateLimited: number;
  skipped: number;
  stopReason: string;
}

export interface LinkFetchOptions {
  limit?: number;
  delayMs?: number;
  githubOnly?: boolean;
  maxMinutes?: number;
  onProgress?: (status: LinkFetchProgress) => void;
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

async function fetchGithubReadme(owner: string, repo: string, token?: string): Promise<FetchedContent | null> {
  if (isRateLimited()) return null;

  // Try GitHub API (returns raw markdown with the Accept header)
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  try {
    const res = await fetch(apiUrl, { headers: githubHeaders(token) });
    updateRateLimit(res.headers);

    if (res.ok) {
      const content = await res.text();
      return {
        title: `${owner}/${repo} README`,
        content: content.slice(0, 500_000), // cap at 500KB
        resolvedUrl: apiUrl,
      };
    }

    if (res.status === 403 || res.status === 429) return null; // rate limited
    // 404 = no README, try fallback
  } catch { /* network error, try fallback */ }

  // Fallback: raw.githubusercontent.com
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`;
  try {
    const res = await fetch(rawUrl, { headers: { 'User-Agent': 'fieldtheory-cli' } });
    if (res.ok) {
      const content = await res.text();
      return {
        title: `${owner}/${repo} README`,
        content: content.slice(0, 500_000),
        resolvedUrl: rawUrl,
      };
    }
  } catch { /* fallback also failed */ }

  return null;
}

async function fetchGithubGist(gistId: string, token?: string): Promise<FetchedContent | null> {
  if (isRateLimited()) return null;

  const apiUrl = `https://api.github.com/gists/${gistId}`;
  try {
    const res = await fetch(apiUrl, {
      headers: {
        ...githubHeaders(token),
        'Accept': 'application/vnd.github.v3+json',
      },
    });
    updateRateLimit(res.headers);

    if (!res.ok) return null;

    const data = await res.json() as {
      description?: string;
      files?: Record<string, { filename?: string; content?: string }>;
    };
    const files = Object.values(data.files ?? {});
    if (files.length === 0) return null;

    const content = files
      .map((f) => `--- ${f.filename ?? 'untitled'} ---\n${f.content ?? ''}`)
      .join('\n\n');

    return {
      title: data.description || files[0]?.filename || `Gist ${gistId}`,
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
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') ?? '';
    // Skip non-HTML responses (PDFs, images, etc.)
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
}

function insertLinkContent(
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

// ── Per-bookmark link fetch helper ───────────────────────────────────────

export { contentId };

export async function fetchLinksForBookmark(
  db: Database,
  bookmarkId: string,
  linksJson: string | null,
  githubUrlsJson: string | null,
  existingContentIds: Set<string>,
  opts: { githubToken?: string; githubOnly?: boolean; delayMs?: number },
): Promise<{ fetched: number; failed: number; rateLimited: number }> {
  const allUrls = new Set<string>();
  if (linksJson) {
    try { for (const u of JSON.parse(linksJson)) allUrls.add(u); } catch {}
  }
  if (githubUrlsJson) {
    try { for (const u of JSON.parse(githubUrlsJson)) allUrls.add(u); } catch {}
  }

  let fetched = 0;
  let failed = 0;
  let rateLimited = 0;

  for (const url of allUrls) {
    const id = contentId(bookmarkId, url);
    if (existingContentIds.has(id)) continue;

    const classified = classifyUrl(url);
    if (!classified) continue;
    if (opts.githubOnly && classified.type === 'article') continue;

    let result: FetchedContent | null = null;

    try {
      if (classified.type === 'github_readme' && classified.owner && classified.repo) {
        if (isRateLimited()) { rateLimited++; continue; }
        result = await fetchGithubReadme(classified.owner, classified.repo, opts.githubToken);
      } else if (classified.type === 'github_gist' && classified.gistId) {
        if (isRateLimited()) { rateLimited++; continue; }
        result = await fetchGithubGist(classified.gistId, opts.githubToken);
      } else if (classified.type === 'article') {
        result = await fetchArticle(url);
      }

      if (result) {
        insertLinkContent(db, id, bookmarkId, url, result.resolvedUrl, classified.type, result.title, result.content, new Date().toISOString());
        existingContentIds.add(id);
        fetched++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }

    if (opts.delayMs && opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }

  return { fetched, failed, rateLimited };
}

// ── Main entry point (standalone command) ────────────────────────────────

export async function fetchLinkContent(options: LinkFetchOptions = {}): Promise<LinkFetchResult> {
  const delayMs = options.delayMs ?? 500;
  const maxMinutes = options.maxMinutes ?? 30;
  const githubOnly = options.githubOnly ?? false;
  const githubToken = process.env.GITHUB_TOKEN || undefined;

  ensureDataDir();
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);

  try {
    ensureLinkContentSchema(db);

    // Get all bookmark URLs to process
    const rows = db.exec(`
      SELECT b.id, b.links_json, b.github_urls
      FROM bookmarks b
      WHERE b.links_json IS NOT NULL OR b.github_urls IS NOT NULL
    `);

    if (!rows.length || !rows[0].values.length) {
      options.onProgress?.({ processed: 0, total: 0, fetched: 0, running: false, done: true });
      return { processed: 0, fetched: 0, failed: 0, rateLimited: 0, skipped: 0, stopReason: 'no links' };
    }

    // Build deduplicated list of (bookmarkId, url) pairs
    const existing = new Set<string>();
    const existingRows = db.exec('SELECT id FROM link_content');
    if (existingRows.length) {
      for (const r of existingRows[0].values) existing.add(r[0] as string);
    }

    const pending: { bookmarkId: string; url: string; classified: ClassifiedUrl }[] = [];

    for (const row of rows[0].values) {
      const bookmarkId = row[0] as string;
      const linksJson = row[1] as string | null;
      const githubJson = row[2] as string | null;

      const allUrls = new Set<string>();
      if (linksJson) {
        try { for (const u of JSON.parse(linksJson)) allUrls.add(u); } catch {}
      }
      if (githubJson) {
        try { for (const u of JSON.parse(githubJson)) allUrls.add(u); } catch {}
      }

      for (const url of allUrls) {
        const id = contentId(bookmarkId, url);
        if (existing.has(id)) continue;

        const classified = classifyUrl(url);
        if (!classified) continue;
        if (githubOnly && classified.type === 'article') continue;

        pending.push({ bookmarkId, url, classified });
      }
    }

    const limit = options.limit ?? pending.length;
    const total = Math.min(pending.length, limit);
    const started = Date.now();
    let processed = 0;
    let fetched = 0;
    let failed = 0;
    let rateLimited = 0;
    let skipped = 0;
    let stopReason = 'completed';

    for (let i = 0; i < total; i++) {
      if (Date.now() - started > maxMinutes * 60_000) {
        stopReason = 'max runtime reached';
        break;
      }

      const { bookmarkId, url, classified } = pending[i];
      let result: FetchedContent | null = null;

      try {
        if (classified.type === 'github_readme' && classified.owner && classified.repo) {
          if (isRateLimited()) {
            rateLimited++;
            processed++;
            continue;
          }
          result = await fetchGithubReadme(classified.owner, classified.repo, githubToken);
        } else if (classified.type === 'github_gist' && classified.gistId) {
          if (isRateLimited()) {
            rateLimited++;
            processed++;
            continue;
          }
          result = await fetchGithubGist(classified.gistId, githubToken);
        } else if (classified.type === 'article') {
          result = await fetchArticle(url);
        }

        if (result) {
          const id = contentId(bookmarkId, url);
          insertLinkContent(db, id, bookmarkId, url, result.resolvedUrl, classified.type, result.title, result.content, new Date().toISOString());
          fetched++;
        } else {
          failed++;
        }

        processed++;
      } catch {
        failed++;
        processed++;
      }

      // Save periodically
      if ((i + 1) % 10 === 0) {
        saveDb(db, dbPath);
      }

      options.onProgress?.({
        processed,
        total,
        fetched,
        running: true,
        done: false,
      });

      if (i < total - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // Rebuild FTS
    if (fetched > 0) {
      db.run(`INSERT INTO link_content_fts(link_content_fts) VALUES('rebuild')`);
    }

    saveDb(db, dbPath);

    options.onProgress?.({
      processed,
      total,
      fetched,
      running: false,
      done: true,
    });

    return {
      processed,
      fetched,
      failed,
      rateLimited,
      skipped: pending.length - total,
      stopReason,
    };
  } finally {
    db.close();
  }
}
