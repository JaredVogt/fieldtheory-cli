import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ensureDir, pathExists, readJson, readJsonLines, writeJson } from './fs.js';
import { bookmarkMediaDir, bookmarkMediaManifestPath, twitterBookmarksCachePath } from './paths.js';
import type { BookmarkRecord } from './types.js';

export interface MediaFetchEntry {
  bookmarkId: string;
  tweetId: string;
  tweetUrl: string;
  authorHandle?: string;
  authorName?: string;
  sourceUrl: string;
  localPath?: string;
  contentType?: string;
  bytes?: number;
  status: 'downloaded' | 'skipped_too_large' | 'failed';
  reason?: string;
  fetchedAt: string;
}

export interface MediaFetchManifest {
  schemaVersion: 1;
  generatedAt: string;
  limit: number;
  maxBytes: number;
  processed: number;
  downloaded: number;
  skippedTooLarge: number;
  failed: number;
  entries: MediaFetchEntry[];
}

function sanitizeExtFromContentType(contentType?: string, sourceUrl?: string): string {
  if (contentType?.includes('jpeg')) return '.jpg';
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('gif')) return '.gif';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('mp4')) return '.mp4';
  try {
    const ext = path.extname(new URL(sourceUrl ?? '').pathname);
    if (ext) return ext;
  } catch {}
  return '.bin';
}

async function loadManifest(): Promise<MediaFetchManifest | null> {
  const manifestPath = bookmarkMediaManifestPath();
  if (!(await pathExists(manifestPath))) return null;
  return readJson<MediaFetchManifest>(manifestPath);
}

// ── Per-bookmark media download helper ───────────────────────────────────

export interface MediaBookmarkInfo {
  id: string;
  tweetId: string;
  url: string;
  authorHandle?: string;
  authorName?: string;
  authorProfileImageUrl?: string;
}

/**
 * Resolve media URLs from mediaObjects (handling both field name conventions)
 * and plain media URL arrays.
 */
export function resolveMediaUrls(
  mediaObjects: any[] | undefined,
  media: string[] | undefined,
  authorProfileImageUrl: string | undefined,
  bookmarkId: string,
  existingKeys: Set<string>,
): string[] {
  const urls: string[] = [];
  if (mediaObjects?.length) {
    for (const mo of mediaObjects) {
      const type = mo.type;
      if (type === 'video' || type === 'animated_gif') {
        // Handle both field name conventions: variants/videoVariants, contentType/content_type
        const variants = mo.variants ?? mo.videoVariants ?? [];
        const mp4s = variants
          .filter((v: any) => (v.contentType === 'video/mp4' || v.content_type === 'video/mp4') && v.url)
          .sort((a: any, b: any) => ((b.bitrate ?? 0) - (a.bitrate ?? 0)));
        if (mp4s.length > 0 && mp4s[0].url) { urls.push(mp4s[0].url); continue; }
      }
      // Handle both: mediaUrl (typed interface) and url (convertTweetToRecord output)
      const mediaUrl = mo.mediaUrl ?? mo.url;
      if (mediaUrl) urls.push(mediaUrl);
    }
  } else if (media?.length) {
    urls.push(...media);
  }

  if (authorProfileImageUrl) {
    const fullUrl = authorProfileImageUrl.replace('_normal.', '_400x400.');
    if (!existingKeys.has(`${bookmarkId}::${fullUrl}`)) urls.push(fullUrl);
  }

  return urls;
}

/**
 * Download media for a single bookmark. Returns new manifest entries.
 */
export async function downloadMediaForBookmark(
  bookmark: MediaBookmarkInfo,
  mediaUrls: string[],
  existingKeys: Set<string>,
  mediaDir: string,
  maxBytes: number,
): Promise<{ entries: MediaFetchEntry[]; downloaded: number; failed: number }> {
  const newEntries: MediaFetchEntry[] = [];
  let downloaded = 0;
  let failed = 0;

  for (const sourceUrl of mediaUrls) {
    const key = `${bookmark.id}::${sourceUrl}`;
    if (existingKeys.has(key)) continue;

    const fetchedAt = new Date().toISOString();

    try {
      const head = await fetch(sourceUrl, { method: 'HEAD' });
      const contentLengthHeader = head.headers.get('content-length');
      const contentType = head.headers.get('content-type') ?? undefined;
      const declaredBytes = contentLengthHeader ? Number(contentLengthHeader) : undefined;

      if (typeof declaredBytes === 'number' && !Number.isNaN(declaredBytes) && declaredBytes > maxBytes) {
        newEntries.push({
          bookmarkId: bookmark.id, tweetId: bookmark.tweetId, tweetUrl: bookmark.url,
          authorHandle: bookmark.authorHandle, authorName: bookmark.authorName,
          sourceUrl, contentType, bytes: declaredBytes,
          status: 'skipped_too_large', reason: `content-length ${declaredBytes} exceeds max ${maxBytes}`, fetchedAt,
        });
        continue;
      }

      const response = await fetch(sourceUrl);
      if (!response.ok) {
        newEntries.push({
          bookmarkId: bookmark.id, tweetId: bookmark.tweetId, tweetUrl: bookmark.url,
          authorHandle: bookmark.authorHandle, authorName: bookmark.authorName,
          sourceUrl, status: 'failed', reason: `HTTP ${response.status}`, fetchedAt,
        });
        failed++;
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        newEntries.push({
          bookmarkId: bookmark.id, tweetId: bookmark.tweetId, tweetUrl: bookmark.url,
          authorHandle: bookmark.authorHandle, authorName: bookmark.authorName,
          sourceUrl, contentType: response.headers.get('content-type') ?? contentType, bytes: buffer.byteLength,
          status: 'skipped_too_large', reason: `downloaded size ${buffer.byteLength} exceeds max ${maxBytes}`, fetchedAt,
        });
        continue;
      }

      const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      const ext = sanitizeExtFromContentType(response.headers.get('content-type') ?? contentType, sourceUrl);
      const filename = `${bookmark.tweetId}-${digest}${ext}`;
      const localPath = path.join(mediaDir, filename);
      await writeFile(localPath, buffer);

      newEntries.push({
        bookmarkId: bookmark.id, tweetId: bookmark.tweetId, tweetUrl: bookmark.url,
        authorHandle: bookmark.authorHandle, authorName: bookmark.authorName,
        sourceUrl, localPath, contentType: response.headers.get('content-type') ?? contentType, bytes: buffer.byteLength,
        status: 'downloaded', fetchedAt,
      });
      downloaded++;
    } catch (error) {
      newEntries.push({
        bookmarkId: bookmark.id, tweetId: bookmark.tweetId, tweetUrl: bookmark.url,
        authorHandle: bookmark.authorHandle, authorName: bookmark.authorName,
        sourceUrl, status: 'failed', reason: error instanceof Error ? error.message : String(error), fetchedAt,
      });
      failed++;
    }
  }

  // Mark all processed URLs as existing to prevent re-processing within this run
  for (const e of newEntries) existingKeys.add(`${e.bookmarkId}::${e.sourceUrl}`);

  return { entries: newEntries, downloaded, failed };
}

// ── Batch media fetch (standalone command) ───────────────────────────────

export { loadManifest };

export async function fetchBookmarkMediaBatch(
  options: { limit?: number; maxBytes?: number } = {}
): Promise<MediaFetchManifest> {
  const limit = options.limit ?? 100;
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const mediaDir = bookmarkMediaDir();
  const manifestPath = bookmarkMediaManifestPath();
  await ensureDir(mediaDir);

  const bookmarks = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
  const candidates = bookmarks
    .filter((b) => (b.media?.length ?? 0) > 0 || (b.mediaObjects?.length ?? 0) > 0 || b.authorProfileImageUrl)
    .slice(0, limit);
  const previous = await loadManifest();
  const priorKeys = new Set((previous?.entries ?? []).map((e) => `${e.bookmarkId}::${e.sourceUrl}`));
  const allEntries: MediaFetchEntry[] = previous?.entries ? [...previous.entries] : [];

  let totalDownloaded = 0;
  let totalFailed = 0;

  for (const bookmark of candidates) {
    const mediaUrls = resolveMediaUrls(bookmark.mediaObjects as any, bookmark.media, bookmark.authorProfileImageUrl, bookmark.id, priorKeys);
    const result = await downloadMediaForBookmark(
      { id: bookmark.id, tweetId: bookmark.tweetId, url: bookmark.url, authorHandle: bookmark.authorHandle, authorName: bookmark.authorName, authorProfileImageUrl: bookmark.authorProfileImageUrl },
      mediaUrls, priorKeys, mediaDir, maxBytes,
    );
    allEntries.push(...result.entries);
    totalDownloaded += result.downloaded;
    totalFailed += result.failed;
  }

  const manifest: MediaFetchManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    limit,
    maxBytes,
    processed: allEntries.length - (previous?.entries?.length ?? 0),
    downloaded: totalDownloaded,
    skippedTooLarge: allEntries.filter((e) => e.status === 'skipped_too_large').length - (previous?.entries?.filter((e) => e.status === 'skipped_too_large').length ?? 0),
    failed: totalFailed,
    entries: allEntries,
  };

  await writeJson(manifestPath, manifest);
  return manifest;
}
