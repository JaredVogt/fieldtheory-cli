import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

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

// ── Per-bookmark media download helper ───────────────────────────────────

export interface MediaBookmarkInfo {
  id: string;
  tweetId: string;
  url: string;
  authorHandle?: string;
  authorName?: string;
}

/**
 * Resolve media URLs from mediaObjects (handling both field name conventions)
 * and plain media URL arrays.
 */
export function resolveMediaUrls(
  mediaObjects: any[] | undefined,
  media: string[] | undefined,
  _authorProfileImageUrl: string | undefined,
  bookmarkId: string,
  existingKeys: Set<string>,
): string[] {
  const urls: string[] = [];
  if (mediaObjects?.length) {
    for (const mo of mediaObjects) {
      const type = mo.type;
      if (type === 'video' || type === 'animated_gif') {
        // Handle both field name conventions: variants/videoVariants, contentType/content_type.
        // Raw `variants` arrays include HLS (m3u8) entries — filter those out.
        // `videoVariants` is our ingestion-side shape, already mp4-filtered with content_type stripped.
        const variants = mo.variants ?? mo.videoVariants ?? [];
        const mp4s = variants
          .filter((v: any) => {
            if (!v.url) return false;
            const ct = v.contentType ?? v.content_type;
            return ct ? ct === 'video/mp4' : true;
          })
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
