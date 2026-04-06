import { writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists } from './fs.js';
import {
  getBookmarksForExport,
  getThreadTweets,
  getLinkContentForBookmark,
  markBookmarksExportedBatch,
  getExportOutputDir,
  setExportOutputDir,
} from './bookmarks-db.js';
import type { ExportableBookmark, ExportFilters, LinkContentRow } from './bookmarks-db.js';
import { loadManifest } from './bookmark-media.js';
import type { MediaFetchEntry } from './bookmark-media.js';
import type { ThreadTweetRecord } from './types.js';

export interface ExportOptions extends ExportFilters {
  outputDir?: string;
  setOutput?: string;
  dryRun?: boolean;
  onProgress?: (processed: number, total: number) => void;
}

export interface ExportResult {
  exported: number;
  skipped: number;
  errors: number;
  outputDir: string;
  dryRun: boolean;
}

export async function exportBookmarksToMarkdown(options: ExportOptions): Promise<ExportResult> {
  // Handle --set-output: save and use as output dir
  if (options.setOutput) {
    const resolved = path.resolve(options.setOutput);
    await setExportOutputDir(resolved);
    if (!options.outputDir) options.outputDir = resolved;
  }

  // Resolve output directory
  const outputDir = options.outputDir
    ? path.resolve(options.outputDir)
    : await getExportOutputDir();

  if (!outputDir) {
    throw new Error(
      'No output directory configured. Run: ft export --set-output /path/to/vault/bookmarks'
    );
  }

  const bookmarks = await getBookmarksForExport(options);

  if (bookmarks.length === 0) {
    return { exported: 0, skipped: 0, errors: 0, outputDir, dryRun: !!options.dryRun };
  }

  if (options.dryRun) {
    return { exported: bookmarks.length, skipped: 0, errors: 0, outputDir, dryRun: true };
  }

  await ensureDir(outputDir);

  // Load media manifest once and build per-bookmark lookup
  const manifest = await loadManifest();
  const mediaByBookmark = new Map<string, MediaFetchEntry[]>();
  if (manifest) {
    for (const entry of manifest.entries) {
      if (entry.status === 'downloaded' && entry.localPath) {
        const list = mediaByBookmark.get(entry.bookmarkId) ?? [];
        list.push(entry);
        mediaByBookmark.set(entry.bookmarkId, list);
      }
    }
  }
  const assetsDir = path.join(outputDir, 'assets');
  let assetsDirCreated = false;

  const now = new Date().toISOString();
  let exported = 0;
  let errors = 0;
  const exportedIds: string[] = [];

  for (const bookmark of bookmarks) {
    try {
      let threadTweets: ThreadTweetRecord[] = [];
      if (bookmark.conversationId) {
        threadTweets = await getThreadTweets(bookmark.conversationId);
      }

      // Gather media entries, filtering out profile images
      const mediaEntries = (mediaByBookmark.get(bookmark.id) ?? []).filter(
        (e) => !e.sourceUrl.includes('profile_images')
      );

      // Copy media files to assets/
      if (mediaEntries.length > 0) {
        if (!assetsDirCreated) {
          await ensureDir(assetsDir);
          assetsDirCreated = true;
        }
        for (const entry of mediaEntries) {
          if (entry.localPath && (await pathExists(entry.localPath))) {
            const basename = path.basename(entry.localPath);
            await copyFile(entry.localPath, path.join(assetsDir, basename));
          }
        }
      }

      // Fetch link content from DB
      const linkContent = await getLinkContentForBookmark(bookmark.id);

      const markdown = renderBookmarkMarkdown(bookmark, threadTweets, now, mediaEntries, linkContent);
      const filename = bookmarkFilename(bookmark);
      await writeFile(path.join(outputDir, filename), markdown, 'utf8');

      exportedIds.push(bookmark.id);
      exported++;
    } catch {
      errors++;
    }

    options.onProgress?.(exported + errors, bookmarks.length);
  }

  if (exportedIds.length > 0) {
    await markBookmarksExportedBatch(exportedIds, now);
  }

  return { exported, skipped: 0, errors, outputDir, dryRun: false };
}

// ── Filename ──────────────────────────────────────────────────────────────

export function bookmarkFilename(bookmark: ExportableBookmark): string {
  const date = resolveDate(bookmark);
  const handle = sanitizeHandle(bookmark.authorHandle);
  return `${date}-${handle}-${bookmark.tweetId}.md`;
}

function resolveDate(bookmark: ExportableBookmark): string {
  const raw = bookmark.postedAt ?? bookmark.bookmarkedAt ?? bookmark.exportedAt ?? new Date().toISOString();
  // Extract YYYY-MM-DD from various formats
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  // Try parsing as Date
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function sanitizeHandle(handle?: string): string {
  if (!handle) return 'unknown';
  return handle.toLowerCase().replace(/[^a-z0-9_]/g, '') || 'unknown';
}

// ── Markdown Rendering ───────────────────────────────────────────────────

export function renderBookmarkMarkdown(
  bookmark: ExportableBookmark,
  threadTweets: ThreadTweetRecord[],
  exportedAt: string,
  mediaEntries: MediaFetchEntry[] = [],
  linkContent: LinkContentRow[] = [],
): string {
  const parts: string[] = [];

  parts.push(renderFrontmatter(bookmark, threadTweets, exportedAt, mediaEntries.length > 0));
  parts.push('');
  parts.push(renderBody(bookmark, threadTweets, mediaEntries, linkContent));

  return parts.join('\n');
}

function renderFrontmatter(
  bookmark: ExportableBookmark,
  threadTweets: ThreadTweetRecord[],
  exportedAt: string,
  hasMedia: boolean = false,
): string {
  const hasThread = threadTweets.length > 0;
  const threadLength = hasThread ? threadTweets.length : undefined;
  const title = generateTitle(bookmark);

  const tags: string[] = ['x/bookmark'];
  if (hasThread) tags.push('x/thread');

  const lines: string[] = ['---'];
  lines.push(`title: ${yamlString(title)}`);
  if (bookmark.authorHandle) lines.push(`author: ${bookmark.authorHandle}`);
  if (bookmark.authorName) lines.push(`author_name: ${yamlString(bookmark.authorName)}`);
  lines.push(`tweet_url: ${bookmark.url}`);
  lines.push(`tweet_id: "${bookmark.tweetId}"`);
  if (bookmark.postedAt) lines.push(`posted_at: ${bookmark.postedAt}`);
  if (bookmark.bookmarkedAt) lines.push(`bookmarked_at: ${bookmark.bookmarkedAt}`);
  if (bookmark.primaryCategory && bookmark.primaryCategory !== 'unclassified') {
    lines.push(`category: ${bookmark.primaryCategory}`);
  }
  if (bookmark.primaryDomain) lines.push(`domain: ${bookmark.primaryDomain}`);
  if (bookmark.categories.length > 0) {
    lines.push('categories:');
    for (const cat of bookmark.categories) lines.push(`  - ${cat}`);
  }
  if (bookmark.domains.length > 0) {
    lines.push('domains:');
    for (const dom of bookmark.domains) lines.push(`  - ${dom}`);
  }
  lines.push('tags:');
  for (const tag of tags) lines.push(`  - ${tag}`);

  if (bookmark.likeCount != null) lines.push(`likes: ${bookmark.likeCount}`);
  if (bookmark.repostCount != null) lines.push(`reposts: ${bookmark.repostCount}`);
  if (bookmark.replyCount != null) lines.push(`replies: ${bookmark.replyCount}`);
  if (bookmark.viewCount != null) lines.push(`views: ${bookmark.viewCount}`);
  lines.push(`has_thread: ${hasThread}`);
  if (threadLength != null) lines.push(`thread_length: ${threadLength}`);
  if (bookmark.mediaCount > 0) lines.push(`media_count: ${bookmark.mediaCount}`);
  if (hasMedia) lines.push(`has_media: true`);
  if (bookmark.links.length > 0) {
    lines.push('links:');
    for (const link of bookmark.links) lines.push(`  - ${link}`);
  }
  if (bookmark.githubUrls.length > 0) {
    lines.push('github_urls:');
    for (const url of bookmark.githubUrls) lines.push(`  - ${url}`);
  }
  lines.push(`exported_at: ${exportedAt}`);
  lines.push('---');

  return lines.join('\n');
}

function renderBody(
  bookmark: ExportableBookmark,
  threadTweets: ThreadTweetRecord[],
  mediaEntries: MediaFetchEntry[] = [],
  linkContent: LinkContentRow[] = [],
): string {
  const parts: string[] = [];

  // Header
  const handle = bookmark.authorHandle ? `@${bookmark.authorHandle}` : 'Unknown Author';
  parts.push(`# ${handle}`);
  parts.push('');

  // Main tweet text
  const text = bookmark.text || '[No text]';
  parts.push(text);
  parts.push('');

  // Media embeds
  if (mediaEntries.length > 0) {
    for (const entry of mediaEntries) {
      if (entry.localPath) {
        const basename = path.basename(entry.localPath);
        parts.push(`![[assets/${basename}]]`);
      }
    }
    parts.push('');
  }

  // Metadata line
  const metaParts: string[] = [];
  const dateStr = formatHumanDate(bookmark.postedAt ?? bookmark.bookmarkedAt);
  if (dateStr) metaParts.push(`**Posted:** ${dateStr}`);
  if (bookmark.likeCount != null) metaParts.push(`**Likes:** ${formatNumber(bookmark.likeCount)}`);
  if (bookmark.repostCount != null) metaParts.push(`**Reposts:** ${formatNumber(bookmark.repostCount)}`);
  if (metaParts.length > 0) {
    parts.push(metaParts.join('  |  '));
  }
  parts.push(`[View on X](${bookmark.url})`);
  parts.push('');

  // Links section
  const allLinks = [...bookmark.links, ...bookmark.githubUrls.filter((u) => !bookmark.links.includes(u))];
  if (allLinks.length > 0) {
    parts.push('## Links');
    parts.push('');
    for (const link of allLinks) {
      const display = link.replace(/^https?:\/\//, '');
      parts.push(`- [${display}](${link})`);
    }
    parts.push('');
  }

  // Link content (collapsible sections)
  if (linkContent.length > 0) {
    for (const lc of linkContent) {
      const heading = lc.title
        ? `${lc.contentType} — ${lc.title}`
        : `${lc.contentType} — ${lc.sourceUrl.replace(/^https?:\/\//, '')}`;
      parts.push(`### ${heading}`);
      parts.push('');
      const sizeLabel = lc.contentBytes != null ? ` (${formatBytes(lc.contentBytes)})` : '';
      const summaryText = lc.title ?? lc.sourceUrl.replace(/^https?:\/\//, '');
      parts.push(`<details>`);
      parts.push(`<summary>${summaryText}${sizeLabel}</summary>`);
      parts.push('');
      parts.push(lc.content);
      parts.push('');
      parts.push(`</details>`);
      parts.push('');
    }
  }

  // Thread section
  // Deduplicate: skip the bookmarked tweet from thread tweets
  const filteredThread = threadTweets.filter((t) => t.tweetId !== bookmark.tweetId);

  if (filteredThread.length > 0) {
    const totalInThread = filteredThread.length + 1; // +1 for the original tweet
    parts.push('---');
    parts.push('');
    parts.push(`## Thread (${totalInThread} tweets)`);
    parts.push('');

    // Include original tweet as 1/N
    parts.push(`### 1/${totalInThread} \u2014 ${handle}`);
    parts.push('');
    parts.push(text);
    parts.push('');

    for (let i = 0; i < filteredThread.length; i++) {
      const tweet = filteredThread[i];
      const pos = i + 2; // 2-indexed since original is 1
      const tweetHandle = tweet.authorHandle ? `@${tweet.authorHandle}` : 'Unknown';
      parts.push(`### ${pos}/${totalInThread} \u2014 ${tweetHandle}`);
      parts.push('');
      parts.push(tweet.text || '[No text]');
      parts.push('');
    }
  }

  return parts.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────

function generateTitle(bookmark: ExportableBookmark): string {
  const handle = bookmark.authorHandle ? `@${bookmark.authorHandle}` : 'Unknown';
  const text = (bookmark.text || '').replace(/\n/g, ' ').trim();
  if (!text) return handle;
  const truncated = text.length > 50 ? text.slice(0, 50).replace(/\s+\S*$/, '') + '...' : text;
  return `${handle} on ${truncated}`;
}

function yamlString(value: string): string {
  if (/[:#{}[\],&*?|>!%@`"']/.test(value) || value.startsWith(' ') || value.endsWith(' ')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function formatHumanDate(dateStr?: string | null): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}
