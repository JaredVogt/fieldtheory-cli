import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, saveDb, type Database } from './db.js';
import { loadChromeSessionConfig } from './config.js';
import { extractChromeXCookies } from './chrome-cookies.js';
import { getQueryId } from './graphql-query-ids.js';
import { fetchBookmarkTimelinePage, GraphQLApiError, type PageResult, type SyncProgress } from './graphql-bookmarks.js';
import { fetchTweetDetailCombined } from './graphql-threads.js';
import {
  buildIndex,
  ensureBookmarkProcessingRow,
  ensureDbSchema,
  getNewestStoredBookmarkId,
  insertBookmarkFailureEvent,
  insertThreadTweet,
  markBookmarkPendingValidation,
  type BookmarkProcessingState,
  type BookmarkStepStatus,
  upsertBookmarkArticle,
  upsertBookmarkRecord,
} from './bookmarks-db.js';
import { fetchTweetArticle, isXArticleUrl } from './graphql-articles.js';
import { ensureDir, pathExists } from './fs.js';
import { bookmarkMediaDir, twitterBookmarksCachePath, twitterBookmarksIndexPath } from './paths.js';
import { downloadMediaForBookmark, resolveMediaUrls } from './bookmark-media.js';
import {
  contentId,
  ensureLinkContentSchema,
  fetchLinkContentByUrl,
  insertLinkContent,
} from './fetch-links.js';
import type { BookmarkRecord, ThreadTweetRecord } from './types.js';

const CLAIM_LEASE_MS = 10 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;

interface ProcessingBookmarkRow {
  id: string;
  tweetId: string;
  url: string;
  text: string;
  authorHandle?: string;
  authorName?: string;
  authorProfileImageUrl?: string;
  conversationId?: string | null;
  postedAt?: string | null;
  bookmarkedAt?: string | null;
  syncedAt: string;
  links: string[];
  media: string[];
  mediaObjects?: any[];
}

export interface ProcessorRuntime {
  db: Database;
  dbPath: string;
  csrfToken: string;
  cookieHeader?: string;
  tweetDetailQueryId: string;
  bookmarksQueryId?: string;
  folderQueryId?: string;
  githubToken?: string;
  mediaDir: string;
  claimOwner: string;
  delayMs: number;
  maxBytes: number;
}

interface FailureState {
  step: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProcessBookmarkResult {
  bookmarkId: string;
  processingState: BookmarkProcessingState;
  skipped: boolean;
  textUpdated: boolean;
  threadTweetsStored: number;
  mediaDownloaded: number;
  mediaPending: number;
  linksFetched: number;
  linksPending: number;
  authorHandle?: string;
  url?: string;
  lastError?: string;
}

export interface SyncEngineProgress {
  page: number;
  discovered: number;
  processed: number;
  completed: number;
  retryableFailed: number;
  terminalIncomplete: number;
  skipped: number;
  stage?: 'preparing' | 'resuming' | 'fetching' | 'processing' | 'completed';
  detail?: string;
  running: boolean;
  done: boolean;
  stopReason?: string;
}

export interface SyncEngineResult {
  pages: number;
  discovered: number;
  processed: number;
  completed: number;
  retryableFailed: number;
  terminalIncomplete: number;
  skipped: number;
  stopReason: string;
}

export interface SyncEngineOptions {
  incremental?: boolean;
  maxPages?: number;
  targetAdds?: number;
  delayMs?: number;
  maxMinutes?: number;
  maxBytes?: number;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  folderId?: string;
  onProgress?: (status: SyncEngineProgress) => void;
  runtimeFactory?: (options: {
    delayMs?: number;
    maxBytes?: number;
    chromeUserDataDir?: string;
    chromeProfileDirectory?: string;
    includeDiscovery?: boolean;
    folderId?: string;
  }) => Promise<ProcessorRuntime>;
  pageFetcher?: (options: Parameters<typeof fetchBookmarkTimelinePage>[0]) => Promise<PageResult>;
}

export interface RetryBookmarksOptions {
  bookmarkIds?: string[];
  includeTerminal?: boolean;
  delayMs?: number;
  maxBytes?: number;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  onBookmarkResult?: (result: ProcessBookmarkResult) => void;
}

export interface RetryBookmarksResult {
  processed: number;
  completed: number;
  retryableFailed: number;
  terminalIncomplete: number;
  skipped: number;
}

export type ProcessorTargetStep = 'all' | 'core' | 'thread' | 'media' | 'links';

export interface BatchProcessProgress {
  step: ProcessorTargetStep;
  processed: number;
  total: number;
  completed: number;
  retryableFailed: number;
  terminalIncomplete: number;
  skipped: number;
  running: boolean;
  done: boolean;
  stopReason?: string;
}

export interface BatchProcessOptions {
  step?: ProcessorTargetStep;
  bookmarkIds?: string[];
  includeTerminal?: boolean;
  force?: boolean;
  limit?: number;
  delayMs?: number;
  maxMinutes?: number;
  maxBytes?: number;
  githubOnly?: boolean;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  onProgress?: (status: BatchProcessProgress) => void;
  onBookmarkResult?: (result: ProcessBookmarkResult) => void;
}

export interface BatchProcessResult extends RetryBookmarksResult {
  total: number;
  stopReason: string;
}

export interface MigrationResult {
  seededFromCache: number;
  processingRowsCreated: number;
  mediaTargetsBackfilled: number;
  linkTargetsBackfilled: number;
  bookmarksPendingValidation: number;
}

async function reprocessBookmarksWithRuntime(
  runtime: ProcessorRuntime,
  options: BatchProcessOptions = {},
): Promise<BatchProcessResult> {
  const step = options.step ?? 'all';
  const bookmarkIds =
    options.bookmarkIds && options.bookmarkIds.length > 0
      ? options.bookmarkIds
      : listBatchBookmarkIds(runtime.db, {
          step,
          includeTerminal: options.includeTerminal,
          force: options.force,
          limit: options.limit,
        });

  if (options.force) {
    const reason = step === 'all' ? 'forced_reprocess' : `forced_${step}_reprocess`;
    markBookmarksPendingValidation(runtime.db, bookmarkIds, reason);
  }

  if (options.includeTerminal && bookmarkIds.length > 0) {
    resetTerminalTargets(runtime.db, bookmarkIds);
  }

  const total = bookmarkIds.length;
  if (total === 0) {
    options.onProgress?.({
      step,
      processed: 0,
      total: 0,
      completed: 0,
      retryableFailed: 0,
      terminalIncomplete: 0,
      skipped: 0,
      running: false,
      done: true,
      stopReason: 'no bookmarks matched',
    });
    return {
      total: 0,
      processed: 0,
      completed: 0,
      retryableFailed: 0,
      terminalIncomplete: 0,
      skipped: 0,
      stopReason: 'no bookmarks matched',
    };
  }

  let processed = 0;
  let completed = 0;
  let retryableFailed = 0;
  let terminalIncomplete = 0;
  let skipped = 0;
  let stopReason = 'completed';
  const started = Date.now();

  for (const bookmarkId of bookmarkIds) {
    if (options.maxMinutes && Date.now() - started > options.maxMinutes * 60_000) {
      stopReason = 'max runtime reached';
      break;
    }

    const result = await processBookmark(bookmarkId, {
      runtime,
      force: false,
      githubOnly: options.githubOnly,
    });
    options.onBookmarkResult?.(result);

    if (result.skipped) {
      skipped++;
    } else {
      processed++;
      if (result.processingState === 'complete') completed++;
      else if (result.processingState === 'retryable_failed') retryableFailed++;
      else terminalIncomplete++;
    }

    options.onProgress?.({
      step,
      processed,
      total,
      completed,
      retryableFailed,
      terminalIncomplete,
      skipped,
      running: true,
      done: false,
    });
  }

  options.onProgress?.({
    step,
    processed,
    total,
    completed,
    retryableFailed,
    terminalIncomplete,
    skipped,
    running: false,
    done: true,
    stopReason,
  });

  return { total, processed, completed, retryableFailed, terminalIncomplete, skipped, stopReason };
}

function mediaTargetId(bookmarkId: string, tweetId: string, sourceUrl: string): string {
  return createHash('sha256').update(`${bookmarkId}::${tweetId}::${sourceUrl}`).digest('hex').slice(0, 24);
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function loadBookmarkRow(db: Database, bookmarkId: string): ProcessingBookmarkRow | null {
  const row = db.exec(
    `SELECT id, tweet_id, url, text, author_handle, author_name, author_profile_image_url,
            conversation_id, posted_at, bookmarked_at, synced_at, links_json, media_json,
            media_objects_json
     FROM bookmarks
     WHERE id = ?`,
    [bookmarkId],
  )[0]?.values?.[0];
  if (!row) return null;
  return {
    id: row[0] as string,
    tweetId: row[1] as string,
    url: row[2] as string,
    text: row[3] as string,
    authorHandle: (row[4] as string) ?? undefined,
    authorName: (row[5] as string) ?? undefined,
    authorProfileImageUrl: (row[6] as string) ?? undefined,
    conversationId: (row[7] as string) ?? null,
    postedAt: (row[8] as string) ?? null,
    bookmarkedAt: (row[9] as string) ?? null,
    syncedAt: row[10] as string,
    links: parseJsonArray(row[11]),
    media: parseJsonArray(row[12]),
    mediaObjects: parseMediaObjectsJson(row[13]),
  };
}

function parseMediaObjectsJson(value: unknown): any[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function classifyTwitterFailure(error: unknown, step: string): FailureState {
  // Prefer the structured code when we have it — message-substring matching is
  // fragile to reword and silently reclassifies failures.
  if (error instanceof GraphQLApiError) {
    return { step, code: error.code, message: error.message, retryable: error.retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('returned 404')) {
    return { step, code: 'http_404', message, retryable: false };
  }
  if (message.includes('returned 403')) {
    return { step, code: 'http_403', message, retryable: false };
  }
  if (message.includes('429') || message.toLowerCase().includes('rate limited')) {
    return { step, code: 'rate_limited', message, retryable: true };
  }
  return { step, code: 'transient_error', message, retryable: true };
}

function deriveConversationTweets(focalTweet: BookmarkRecord | null, threadTweets: ThreadTweetRecord[]): ThreadTweetRecord[] {
  const byId = new Map<string, ThreadTweetRecord>();
  for (const tweet of threadTweets) {
    byId.set(tweet.tweetId, tweet);
  }
  if (focalTweet && !byId.has(focalTweet.tweetId)) {
    byId.set(focalTweet.tweetId, {
      id: focalTweet.tweetId,
      tweetId: focalTweet.tweetId,
      conversationId: focalTweet.conversationId ?? focalTweet.tweetId,
      url: focalTweet.url,
      text: focalTweet.text,
      authorHandle: focalTweet.authorHandle,
      authorName: focalTweet.authorName,
      authorProfileImageUrl: focalTweet.authorProfileImageUrl,
      postedAt: focalTweet.postedAt,
      syncedAt: focalTweet.syncedAt,
      inReplyToStatusId: focalTweet.inReplyToStatusId,
      language: focalTweet.language,
      threadPosition: 0,
      isRoot: true,
      parentTweetId: focalTweet.inReplyToStatusId,
      engagement: focalTweet.engagement,
      media: focalTweet.media,
      mediaObjects: focalTweet.mediaObjects,
      links: focalTweet.links,
    });
  }
  return [...byId.values()].sort((a, b) => a.threadPosition - b.threadPosition);
}

// Media is only downloaded for the focal (bookmarked) tweet and a quoted tweet
// embedded inside it. Reply tweets in the thread can carry their own media
// (quoted videos, reaction clips) but the user bookmarked the focal — pulling
// reply media blows up download volume with content unrelated to what was saved.
interface MediaSourceTweet {
  tweetId: string;
  media?: string[];
  mediaObjects?: any[];
}

function deriveExpectedMediaTargets(bookmarkId: string, tweets: MediaSourceTweet[]): Array<{ id: string; bookmarkId: string; tweetId: string; sourceUrl: string }> {
  const targets: Array<{ id: string; bookmarkId: string; tweetId: string; sourceUrl: string }> = [];
  const seen = new Set<string>();
  for (const tweet of tweets) {
    const urls = resolveMediaUrls(tweet.mediaObjects as any, tweet.media, undefined, bookmarkId, new Set());
    for (const sourceUrl of urls) {
      const key = `${bookmarkId}::${sourceUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        id: mediaTargetId(bookmarkId, tweet.tweetId, sourceUrl),
        bookmarkId,
        tweetId: tweet.tweetId,
        sourceUrl,
      });
    }
  }
  return targets;
}

function isPlausibleLinkTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Skip x.com / twitter.com links — we handle tweets natively
    if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') return false;
    // Skip t.co shortlinks
    if (host === 't.co') return false;

    // Hostname must contain a dot (rejects e.g. "6.Review" parsed as host "6.review")
    const dotParts = host.split('.');
    if (dotParts.length < 2) return false;

    // Reject hostnames that look like filenames (e.g. "server.py", "script.sh")
    // Only flag TLDs that are unambiguously code extensions (not real country TLDs like .sh, .md, .io)
    const tld = dotParts[dotParts.length - 1];
    const unambiguousCodeExtensions = ['py', 'js', 'ts', 'rb', 'rs', 'cpp', 'java', 'php', 'lua', 'sql', 'yaml', 'yml', 'json', 'xml', 'csv', 'txt', 'log'];
    if (dotParts.length === 2 && unambiguousCodeExtensions.includes(tld)) return false;

    // Reject single-char domain parts before the TLD (e.g. "6.Review" -> parts ["6", "review"])
    if (dotParts.length === 2 && /^\d+$/.test(dotParts[0])) return false;

    return true;
  } catch {
    return false;
  }
}

function deriveExpectedLinkTargets(bookmarkId: string, focalTweet: BookmarkRecord | null, tweets: ThreadTweetRecord[]): string[] {
  const urls = new Set<string>();
  for (const link of focalTweet?.links ?? []) urls.add(link);
  for (const tweet of tweets) {
    for (const link of tweet.links ?? []) urls.add(link);
  }
  return [...urls].filter(isPlausibleLinkTarget);
}

function syncMediaTargets(db: Database, bookmarkId: string, targets: Array<{ id: string; bookmarkId: string; tweetId: string; sourceUrl: string }>): void {
  const now = nowIso();
  const existingRows = db.exec(
    `SELECT id, source_url FROM bookmark_media_targets WHERE bookmark_id = ?`,
    [bookmarkId],
  )[0]?.values ?? [];
  const existingByUrl = new Map(existingRows.map((row) => [row[1] as string, row[0] as string]));
  const expectedUrls = new Set(targets.map((target) => target.sourceUrl));

  for (const target of targets) {
    const existingId = existingByUrl.get(target.sourceUrl);
    if (!existingId) {
      db.run(
        `INSERT INTO bookmark_media_targets (
          id, bookmark_id, tweet_id, source_url, status, attempt_count, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
        [target.id, target.bookmarkId, target.tweetId, target.sourceUrl, now],
      );
      continue;
    }
    db.run(
      `UPDATE bookmark_media_targets
       SET tweet_id = ?, updated_at = ?
       WHERE bookmark_id = ? AND source_url = ?`,
      [target.tweetId, now, bookmarkId, target.sourceUrl],
    );
  }

  for (const [sourceUrl] of existingByUrl.entries()) {
    if (!expectedUrls.has(sourceUrl)) {
      db.run(`DELETE FROM bookmark_media_targets WHERE bookmark_id = ? AND source_url = ?`, [bookmarkId, sourceUrl]);
    }
  }
}

function resetTerminalTargets(db: Database, bookmarkIds: string[]): void {
  const now = nowIso();
  db.run('BEGIN TRANSACTION');
  try {
    for (const bookmarkId of bookmarkIds) {
      db.run(
        `UPDATE bookmark_link_targets
         SET status = 'pending', last_error = NULL, attempt_count = 0, updated_at = ?
         WHERE bookmark_id = ? AND status = 'terminal_incomplete'`,
        [now, bookmarkId],
      );
      db.run(
        `UPDATE bookmark_media_targets
         SET status = 'pending', last_error = NULL, attempt_count = 0, updated_at = ?
         WHERE bookmark_id = ? AND status = 'terminal_incomplete'`,
        [now, bookmarkId],
      );
      db.run(
        `UPDATE bookmark_processing
         SET processing_state = 'pending',
             requires_revalidation = 1,
             next_retry_at = NULL,
             updated_at = ?
         WHERE bookmark_id = ? AND processing_state = 'terminal_incomplete'`,
        [now, bookmarkId],
      );
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

function syncLinkTargets(db: Database, bookmarkId: string, urls: string[]): void {
  const now = nowIso();
  const existingRows = db.exec(
    `SELECT id, source_url FROM bookmark_link_targets WHERE bookmark_id = ?`,
    [bookmarkId],
  )[0]?.values ?? [];
  const existingByUrl = new Map(existingRows.map((row) => [row[1] as string, row[0] as string]));
  const expected = new Set(urls);

  for (const sourceUrl of urls) {
    const id = contentId(bookmarkId, sourceUrl);
    if (!existingByUrl.has(sourceUrl)) {
      db.run(
        `INSERT INTO bookmark_link_targets (
          id, bookmark_id, source_url, status, attempt_count, updated_at
        ) VALUES (?, ?, ?, 'pending', 0, ?)`,
        [id, bookmarkId, sourceUrl, now],
      );
      continue;
    }
    db.run(
      `UPDATE bookmark_link_targets SET updated_at = ? WHERE bookmark_id = ? AND source_url = ?`,
      [now, bookmarkId, sourceUrl],
    );
  }

  for (const [sourceUrl] of existingByUrl.entries()) {
    if (!expected.has(sourceUrl)) {
      db.run(`DELETE FROM bookmark_link_targets WHERE bookmark_id = ? AND source_url = ?`, [bookmarkId, sourceUrl]);
    }
  }
}

function setBookmarkInProgress(db: Database, bookmarkId: string, claimOwner: string): void {
  const now = nowIso();
  ensureBookmarkProcessingRow(db, bookmarkId);
  // Once we've decided to (re)process this bookmark, give any previously
  // terminal_incomplete targets another shot. Otherwise processLinkTargets /
  // processMediaTargets skip them forever and validateBookmark keeps flagging
  // the bookmark terminal_incomplete in silence. Rows that genuinely can't be
  // fetched will transition back to terminal_incomplete at the end of this
  // attempt.
  resetTerminalTargets(db, [bookmarkId]);
  db.run(
    `UPDATE bookmark_processing
     SET processing_state = 'in_progress',
         core_status = 'in_progress',
         thread_status = 'pending',
         media_status = 'pending',
         links_status = 'pending',
         attempt_count = attempt_count + 1,
         last_error_step = NULL,
         last_error_code = NULL,
         last_error_message = NULL,
         next_retry_at = NULL,
         claimed_at = ?,
         claim_owner = ?,
         completed_at = NULL,
         updated_at = ?
     WHERE bookmark_id = ?`,
    [now, claimOwner, now, bookmarkId],
  );
}

function canClaimBookmark(db: Database, bookmarkId: string, claimOwner: string): boolean {
  ensureBookmarkProcessingRow(db, bookmarkId);
  const row = db.exec(
    `SELECT processing_state, claimed_at, claim_owner, requires_revalidation
     FROM bookmark_processing
     WHERE bookmark_id = ?`,
    [bookmarkId],
  )[0]?.values?.[0];
  if (!row) return true;
  const processingState = row[0] as BookmarkProcessingState;
  const claimedAt = row[1] as string | null;
  const existingOwner = row[2] as string | null;
  const requiresRevalidation = Boolean(row[3]);
  if (processingState === 'complete' && !requiresRevalidation) return false;
  if (!claimedAt) return true;
  if (existingOwner === claimOwner) return true;
  const age = Date.now() - new Date(claimedAt).getTime();
  return age > CLAIM_LEASE_MS;
}

function releaseClaim(db: Database, bookmarkId: string): void {
  db.run(
    `UPDATE bookmark_processing
     SET claimed_at = NULL, claim_owner = NULL, updated_at = ?
     WHERE bookmark_id = ?`,
    [nowIso(), bookmarkId],
  );
}

function buildBatchSelectionClause(step: ProcessorTargetStep): string {
  switch (step) {
    case 'core':
      return `(p.requires_revalidation = 1 OR p.core_status != 'complete')`;
    case 'thread':
      return `(p.requires_revalidation = 1 OR p.core_status != 'complete' OR p.thread_status != 'complete')`;
    case 'media':
      return `(p.requires_revalidation = 1 OR p.core_status != 'complete' OR p.thread_status != 'complete' OR p.media_status != 'complete')`;
    case 'links':
      return `(p.requires_revalidation = 1 OR p.core_status != 'complete' OR p.thread_status != 'complete' OR p.links_status != 'complete')`;
    case 'all':
    default:
      return `(p.requires_revalidation = 1 OR p.processing_state != 'complete')`;
  }
}

function listBatchBookmarkIds(
  db: Database,
  options: {
    step: ProcessorTargetStep;
    includeTerminal?: boolean;
    force?: boolean;
    limit?: number;
  },
): string[] {
  const params: Array<string | number> = [];
  const conditions: string[] = [];

  if (!options.force) {
    conditions.push(buildBatchSelectionClause(options.step));
    if (!options.includeTerminal) {
      conditions.push(`(p.processing_state != 'terminal_incomplete' OR p.requires_revalidation = 1)`);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = options.limit && options.limit > 0 ? 'LIMIT ?' : '';
  if (limitClause) params.push(options.limit as number);

  const rows = db.exec(
    `SELECT b.id
     FROM bookmarks b
     JOIN bookmark_processing p ON p.bookmark_id = b.id
     ${where}
     ORDER BY p.updated_at ASC
     ${limitClause}`,
    params,
  )[0]?.values ?? [];
  return rows.map((row) => row[0] as string);
}

function markBookmarksPendingValidation(
  db: Database,
  bookmarkIds: string[],
  reason: string,
): void {
  if (bookmarkIds.length === 0) return;
  db.run('BEGIN TRANSACTION');
  try {
    for (const bookmarkId of bookmarkIds) {
      markBookmarkPendingValidation(db, bookmarkId, reason);
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

function updateStepFailure(db: Database, bookmarkId: string, failure: FailureState): void {
  const now = nowIso();
  db.run(
    `UPDATE bookmark_processing
     SET last_error_step = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
     WHERE bookmark_id = ?`,
    [failure.step, failure.code, failure.message.slice(0, 500), now, bookmarkId],
  );
}

function logFailureEvent(
  db: Database,
  bookmarkId: string,
  failure: FailureState,
  options: {
    targetKind?: 'bookmark' | 'media' | 'link';
    targetRef?: string | null;
  } = {},
): void {
  insertBookmarkFailureEvent(db, {
    id: randomUUID(),
    bookmarkId,
    step: failure.step,
    targetKind: options.targetKind ?? 'bookmark',
    targetRef: options.targetRef ?? null,
    failureCode: failure.code,
    failureMessage: failure.message.slice(0, 500),
    retryable: failure.retryable,
    processingState: failure.retryable ? 'retryable_failed' : 'terminal_incomplete',
    occurredAt: nowIso(),
  });
}

function updateTargetFailureStatus(db: Database, table: 'bookmark_media_targets' | 'bookmark_link_targets', bookmarkId: string, sourceUrl: string, failure: FailureState): void {
  const now = nowIso();
  const status = failure.retryable ? 'retryable_failed' : 'terminal_incomplete';
  db.run(
    `UPDATE ${table}
     SET status = ?, attempt_count = attempt_count + 1, last_error = ?, last_attempt_at = ?, updated_at = ?
     WHERE bookmark_id = ? AND source_url = ?`,
    [status, failure.message.slice(0, 500), now, now, bookmarkId, sourceUrl],
  );
}

function validateBookmark(db: Database, bookmarkId: string): BookmarkProcessingState {
  const now = nowIso();
  const coreRow = db.exec(
    `SELECT COUNT(*) FROM bookmarks WHERE id = ? AND text IS NOT NULL AND url IS NOT NULL`,
    [bookmarkId],
  )[0]?.values?.[0]?.[0];
  const threadRow = db.exec(
    `SELECT COUNT(*) FROM thread_tweets WHERE conversation_id = COALESCE((SELECT conversation_id FROM bookmarks WHERE id = ?), (SELECT tweet_id FROM bookmarks WHERE id = ?))`,
    [bookmarkId, bookmarkId],
  )[0]?.values?.[0]?.[0];
  const mediaRows = db.exec(
    `SELECT status, local_path FROM bookmark_media_targets WHERE bookmark_id = ?`,
    [bookmarkId],
  )[0]?.values ?? [];
  const linkRows = db.exec(
    `SELECT status FROM bookmark_link_targets WHERE bookmark_id = ?`,
    [bookmarkId],
  )[0]?.values ?? [];

  const mediaHasFailures = mediaRows.some((row) => row[0] !== 'downloaded' || !row[1] || !fs.existsSync(String(row[1])));
  const mediaRetryable = mediaRows.some((row) => row[0] === 'retryable_failed' || (row[0] === 'downloaded' && row[1] && !fs.existsSync(String(row[1]))));
  const linkHasFailures = linkRows.some((row) => row[0] !== 'fetched');
  const linkRetryable = linkRows.some((row) => row[0] === 'retryable_failed');

  const coreStatus: BookmarkStepStatus = Number(coreRow ?? 0) > 0 ? 'complete' : 'incomplete';
  const threadStatus: BookmarkStepStatus = Number(threadRow ?? 0) > 0 ? 'complete' : 'incomplete';
  const mediaStatus: BookmarkStepStatus = mediaRows.length === 0 || !mediaHasFailures ? 'complete' : 'incomplete';
  const linksStatus: BookmarkStepStatus = linkRows.length === 0 || !linkHasFailures ? 'complete' : 'incomplete';

  let processingState: BookmarkProcessingState = 'complete';
  if ([coreStatus, threadStatus, mediaStatus, linksStatus].some((status) => status !== 'complete')) {
    processingState = mediaRetryable || linkRetryable ? 'retryable_failed' : 'terminal_incomplete';
  }

  db.run(
    `UPDATE bookmark_processing
     SET processing_state = ?,
         core_status = ?,
         thread_status = ?,
         media_status = ?,
         links_status = ?,
         completed_at = CASE WHEN ? = 'complete' THEN ? ELSE NULL END,
         next_retry_at = CASE WHEN ? = 'retryable_failed' THEN ? ELSE NULL END,
         requires_revalidation = 0,
         updated_at = ?,
         claimed_at = NULL,
         claim_owner = NULL
     WHERE bookmark_id = ?`,
    [
      processingState,
      coreStatus,
      threadStatus,
      mediaStatus,
      linksStatus,
      processingState,
      now,
      processingState,
      new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
      now,
      bookmarkId,
    ],
  );

  return processingState;
}

async function processMediaTargets(db: Database, runtime: ProcessorRuntime, bookmark: ProcessingBookmarkRow): Promise<{ downloaded: number; pending: number }> {
  const rows = db.exec(
    `SELECT source_url, status, local_path, tweet_id
     FROM bookmark_media_targets
     WHERE bookmark_id = ?
     ORDER BY updated_at ASC`,
    [bookmark.id],
  )[0]?.values ?? [];

  const existingKeys = new Set<string>();
  for (const row of rows) {
    const sourceUrl = row[0] as string;
    const status = row[1] as string;
    const localPath = row[2] as string | null;
    if (status === 'downloaded' && localPath && fs.existsSync(localPath)) {
      existingKeys.add(`${bookmark.id}::${sourceUrl}`);
    }
  }

  const pendingUrls = rows
    .filter((row) => {
      const status = row[1] as string;
      const localPath = row[2] as string | null;
      if (status === 'downloaded' && localPath && fs.existsSync(localPath)) return false;
      return status !== 'terminal_incomplete';
    })
    .map((row) => row[0] as string);

  if (pendingUrls.length === 0) {
    const pending = rows.filter((row) => row[1] !== 'downloaded').length;
    return { downloaded: 0, pending };
  }

  const result = await downloadMediaForBookmark(
    {
      id: bookmark.id,
      tweetId: bookmark.tweetId,
      url: bookmark.url,
      authorHandle: bookmark.authorHandle,
      authorName: bookmark.authorName,
    },
    pendingUrls,
    existingKeys,
    runtime.mediaDir,
    runtime.maxBytes,
  );

  for (const entry of result.entries) {
    if (entry.status === 'downloaded') {
      db.run(
        `UPDATE bookmark_media_targets
         SET status = 'downloaded',
             content_type = ?,
             local_path = ?,
             bytes = ?,
             downloaded_at = ?,
             last_error = NULL,
             last_attempt_at = ?,
             updated_at = ?
         WHERE bookmark_id = ? AND source_url = ?`,
        [
          entry.contentType ?? null,
          entry.localPath ?? null,
          entry.bytes ?? null,
          entry.fetchedAt,
          entry.fetchedAt,
          entry.fetchedAt,
          bookmark.id,
          entry.sourceUrl,
        ],
      );
      continue;
    }

    const failure: FailureState =
      entry.status === 'skipped_too_large'
        ? { step: 'media', code: 'too_large', message: entry.reason ?? 'media_too_large', retryable: false }
        : entry.reason?.includes('HTTP 404')
          ? { step: 'media', code: 'http_404', message: entry.reason, retryable: false }
          : entry.reason?.includes('HTTP 403')
            ? { step: 'media', code: 'http_403', message: entry.reason, retryable: false }
            : { step: 'media', code: 'download_failed', message: entry.reason ?? 'download_failed', retryable: true };
    updateTargetFailureStatus(db, 'bookmark_media_targets', bookmark.id, entry.sourceUrl, failure);
    updateStepFailure(db, bookmark.id, failure);
    logFailureEvent(db, bookmark.id, failure, { targetKind: 'media', targetRef: entry.sourceUrl });
  }

  const pending = db.exec(
    `SELECT COUNT(*) FROM bookmark_media_targets
     WHERE bookmark_id = ? AND status != 'downloaded'`,
    [bookmark.id],
  )[0]?.values?.[0]?.[0] as number | undefined;
  return { downloaded: result.downloaded, pending: Number(pending ?? 0) };
}

async function processLinkTargets(
  db: Database,
  runtime: ProcessorRuntime,
  bookmarkId: string,
  options: { githubOnly?: boolean } = {},
): Promise<{ fetched: number; pending: number }> {
  ensureLinkContentSchema(db);
  const rows = db.exec(
    `SELECT source_url, status FROM bookmark_link_targets WHERE bookmark_id = ? ORDER BY updated_at ASC`,
    [bookmarkId],
  )[0]?.values ?? [];

  let fetched = 0;
  for (const row of rows) {
    const sourceUrl = row[0] as string;
    const status = row[1] as string;
    if (status === 'fetched' || status === 'terminal_incomplete') continue;

    const outcome = await fetchLinkContentByUrl(sourceUrl, {
      githubToken: runtime.githubToken,
      githubOnly: options.githubOnly,
    });
    if (outcome.fetchedContent && outcome.classified) {
      insertLinkContent(
        db,
        contentId(bookmarkId, sourceUrl),
        bookmarkId,
        sourceUrl,
        outcome.fetchedContent.resolvedUrl,
        outcome.classified.type,
        outcome.fetchedContent.title,
        outcome.fetchedContent.content,
        nowIso(),
      );
      // Partial-fetch path: content was stored (e.g., gist raw fallback) but
      // the underlying fetch was degraded. Keep the target retryable so the
      // next run can upgrade to the full content. Otherwise mark fetched.
      const targetStatus = outcome.retryable ? 'retryable_failed' : 'fetched';
      const targetError = outcome.retryable ? (outcome.failure ?? 'partial_fetch') : null;
      db.run(
        `UPDATE bookmark_link_targets
         SET resolved_url = ?, content_type = ?, status = ?,
             attempt_count = attempt_count + 1,
             last_error = ?,
             last_attempt_at = ?,
             fetched_at = ?,
             updated_at = ?
         WHERE bookmark_id = ? AND source_url = ?`,
        [
          outcome.fetchedContent.resolvedUrl ?? null,
          outcome.classified.type,
          targetStatus,
          targetError,
          nowIso(),
          nowIso(),
          nowIso(),
          bookmarkId,
          sourceUrl,
        ],
      );
      if (targetStatus === 'fetched') fetched++;
      continue;
    }

    const failure: FailureState = {
      step: 'links',
      code: outcome.failure ?? 'link_fetch_failed',
      message: outcome.failure ?? 'link_fetch_failed',
      retryable: outcome.retryable,
    };
    updateTargetFailureStatus(db, 'bookmark_link_targets', bookmarkId, sourceUrl, failure);
    updateStepFailure(db, bookmarkId, failure);
    logFailureEvent(db, bookmarkId, failure, { targetKind: 'link', targetRef: sourceUrl });
  }

  const pending = db.exec(
    `SELECT COUNT(*) FROM bookmark_link_targets WHERE bookmark_id = ? AND status != 'fetched'`,
    [bookmarkId],
  )[0]?.values?.[0]?.[0] as number | undefined;
  return { fetched, pending: Number(pending ?? 0) };
}

/**
 * Fetch X native article bodies for a focal (and optionally quoted) tweet and
 * persist them to the bookmark rows. Only runs for tweets whose `links`
 * contain an x.com article URL. Non-fatal: surfaces warnings on failure but
 * never blocks the larger processing pipeline.
 */
async function fetchAndStoreArticles(
  db: Database,
  runtime: ProcessorRuntime,
  focalTweet: BookmarkRecord | null,
  quotedTweet: BookmarkRecord | null,
): Promise<void> {
  const targets: BookmarkRecord[] = [];
  if (focalTweet && (focalTweet.links ?? []).some(isXArticleUrl)) targets.push(focalTweet);
  if (quotedTweet && (quotedTweet.links ?? []).some(isXArticleUrl)) targets.push(quotedTweet);
  if (targets.length === 0) return;

  for (const tweet of targets) {
    try {
      const article = await fetchTweetArticle(
        tweet.tweetId,
        runtime.csrfToken,
        runtime.cookieHeader,
      );
      if (article) {
        upsertBookmarkArticle(db, tweet.id, article);
      }
    } catch (error) {
      // Log but don't fail the whole bookmark — article fetch is additive.
      const message = (error as Error).message ?? String(error);
      insertBookmarkFailureEvent(db, {
        id: randomUUID(),
        bookmarkId: tweet.id,
        step: 'article',
        targetKind: 'bookmark',
        targetRef: tweet.url,
        failureCode: (error as any)?.code ?? 'article_fetch_failed',
        failureMessage: message.slice(0, 500),
        retryable: Boolean((error as any)?.retryable),
        occurredAt: nowIso(),
      });
    }
  }
}

export interface ArticleBackfillProgress {
  processed: number;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  running: boolean;
  done: boolean;
  stopReason?: string;
}

export interface ArticleBackfillOptions {
  limit?: number;
  delayMs?: number;
  maxMinutes?: number;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  force?: boolean;
  onProgress?: (status: ArticleBackfillProgress) => void;
}

export interface ArticleBackfillResult {
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
  stopReason: string;
}

/**
 * Backfill articles for every bookmark whose `links` contain an x.com
 * article URL and whose `article_text` is not yet populated.
 */
export async function backfillArticles(options: ArticleBackfillOptions = {}): Promise<ArticleBackfillResult> {
  const runtime = await buildRuntime({
    delayMs: options.delayMs,
    chromeUserDataDir: options.chromeUserDataDir,
    chromeProfileDirectory: options.chromeProfileDirectory,
  });

  try {
    const whereArticle = options.force
      ? `links_json LIKE '%/article/%'`
      : `article_text IS NULL AND links_json LIKE '%/article/%'`;
    const rows = runtime.db.exec(
      `SELECT id, tweet_id, url, links_json
       FROM bookmarks
       WHERE ${whereArticle}`,
    )[0]?.values ?? [];

    const targets = rows
      .map((row) => ({
        id: row[0] as string,
        tweetId: row[1] as string,
        url: row[2] as string,
        links: parseLinksJson(row[3] as string | null),
      }))
      .filter((r) => r.links.some(isXArticleUrl));

    const limit = options.limit && options.limit > 0 ? options.limit : targets.length;
    const batch = targets.slice(0, limit);
    const total = batch.length;

    let processed = 0;
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let stopReason = 'completed';
    const started = Date.now();

    for (const target of batch) {
      if (options.maxMinutes && Date.now() - started > options.maxMinutes * 60_000) {
        stopReason = 'max runtime reached';
        break;
      }

      processed++;
      try {
        const article = await fetchTweetArticle(
          target.tweetId,
          runtime.csrfToken,
          runtime.cookieHeader,
        );
        if (article) {
          upsertBookmarkArticle(runtime.db, target.id, article);
          completed++;
        } else {
          skipped++;
        }
      } catch (error) {
        failed++;
        const message = (error as Error).message ?? String(error);
        insertBookmarkFailureEvent(runtime.db, {
          id: randomUUID(),
          bookmarkId: target.id,
          step: 'article',
          targetKind: 'bookmark',
          targetRef: target.url,
          failureCode: (error as any)?.code ?? 'article_fetch_failed',
          failureMessage: message.slice(0, 500),
          retryable: Boolean((error as any)?.retryable),
          occurredAt: nowIso(),
        });
      }

      options.onProgress?.({
        processed,
        total,
        completed,
        failed,
        skipped,
        running: true,
        done: false,
      });

      if (runtime.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, runtime.delayMs));
      }
    }

    await saveDb(runtime.db, runtime.dbPath);
    options.onProgress?.({
      processed,
      total,
      completed,
      failed,
      skipped,
      running: false,
      done: true,
      stopReason,
    });

    return { processed, completed, failed, skipped, stopReason };
  } finally {
    runtime.db.close();
  }
}

function parseLinksJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function buildRuntime(options: {
  delayMs?: number;
  maxBytes?: number;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  includeDiscovery?: boolean;
  folderId?: string;
}): Promise<ProcessorRuntime> {
  const chromeConfig = loadChromeSessionConfig();
  const chromeDir = options.chromeUserDataDir ?? chromeConfig.chromeUserDataDir;
  const chromeProfile = options.chromeProfileDirectory ?? chromeConfig.chromeProfileDirectory;
  const cookies = extractChromeXCookies(chromeDir, chromeProfile);
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  ensureLinkContentSchema(db);

  const bookmarksQueryId = options.includeDiscovery && !options.folderId ? await getQueryId('Bookmarks') : undefined;
  const folderQueryId = options.includeDiscovery && options.folderId ? await getQueryId('BookmarkFolderTimeline') : undefined;

  const mediaDir = bookmarkMediaDir();
  await ensureDir(mediaDir);

  return {
    db,
    dbPath,
    csrfToken: cookies.csrfToken,
    cookieHeader: cookies.cookieHeader,
    tweetDetailQueryId: await getQueryId('TweetDetail'),
    bookmarksQueryId,
    folderQueryId,
    githubToken: process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || undefined,
    mediaDir,
    claimOwner: `ft-${randomUUID()}`,
    delayMs: options.delayMs ?? 600,
    maxBytes: options.maxBytes ?? 50 * 1024 * 1024,
  };
}

export async function migrateLegacyData(): Promise<MigrationResult> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);

  let seededFromCache = 0;
  let processingRowsCreated = 0;
  let mediaTargetsBackfilled = 0;
  let linkTargetsBackfilled = 0;
  let bookmarksPendingValidation = 0;

  try {
    const bookmarkCount = Number(db.exec(`SELECT COUNT(*) FROM bookmarks`)[0]?.values?.[0]?.[0] ?? 0);
    const alreadyMigrated = (db.exec(
      `SELECT value FROM sync_state WHERE key = 'legacy_migration_v1'`,
    )[0]?.values?.[0]?.[0] as string | undefined) === 'done';
    if (bookmarkCount === 0 && await pathExists(twitterBookmarksCachePath())) {
      const result = await buildIndex();
      seededFromCache = result.newRecords;
    }

    db.run(
      `INSERT OR IGNORE INTO bookmark_processing (
        bookmark_id, processing_state, core_status, thread_status, media_status, links_status,
        attempt_count, requires_revalidation, updated_at
      )
      SELECT id, 'pending', 'pending', 'pending', 'pending', 'pending', 0, 1, COALESCE(synced_at, posted_at, bookmarked_at, ?)
      FROM bookmarks`,
      [nowIso()],
    );
    processingRowsCreated = Number(db.exec(`SELECT changes()`)[0]?.values?.[0]?.[0] ?? 0);

    const hasLinkContentTable = (db.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'link_content'`,
    )[0]?.values?.length ?? 0) > 0;
    if (hasLinkContentTable) {
      const linkRows = db.exec(
        `SELECT id, bookmark_id, source_url, resolved_url, content_type, fetched_at FROM link_content`,
      )[0]?.values ?? [];
      for (const row of linkRows) {
        db.run(
          `INSERT OR IGNORE INTO bookmark_link_targets (
            id, bookmark_id, source_url, resolved_url, content_type, status, attempt_count, fetched_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'fetched', 1, ?, ?)`,
          [row[0], row[1], row[2], row[3] ?? null, row[4], row[5], row[5] ?? nowIso()],
        );
      }
      linkTargetsBackfilled = Number(db.exec(`SELECT COUNT(*) FROM bookmark_link_targets`)[0]?.values?.[0]?.[0] ?? 0);
    }

    const manifestPath = path.join(path.dirname(dbPath), 'media-manifest.json');
    if (await pathExists(manifestPath)) {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        entries?: Array<{
          bookmarkId: string;
          tweetId: string;
          sourceUrl: string;
          localPath?: string;
          contentType?: string;
          bytes?: number;
          status: string;
          fetchedAt: string;
        }>;
      };
      for (const entry of raw.entries ?? []) {
        if (entry.status !== 'downloaded' || !entry.localPath) continue;
        db.run(
          `INSERT OR IGNORE INTO bookmark_media_targets (
            id, bookmark_id, tweet_id, source_url, content_type, local_path, bytes,
            status, attempt_count, downloaded_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'downloaded', 1, ?, ?)`,
          [
            mediaTargetId(entry.bookmarkId, entry.tweetId, entry.sourceUrl),
            entry.bookmarkId,
            entry.tweetId,
            entry.sourceUrl,
            entry.contentType ?? null,
            entry.localPath,
            entry.bytes ?? null,
            entry.fetchedAt,
            entry.fetchedAt,
          ],
        );
      }
      mediaTargetsBackfilled = Number(db.exec(`SELECT changes()`)[0]?.values?.[0]?.[0] ?? 0);
    }

    if (!alreadyMigrated) {
      db.run(
        `UPDATE bookmark_processing
         SET processing_state = 'pending',
             core_status = 'pending',
             thread_status = 'pending',
             media_status = 'pending',
             links_status = 'pending',
             next_retry_at = NULL,
             completed_at = NULL,
             requires_revalidation = 1,
             updated_at = ?`,
        [nowIso()],
      );
      bookmarksPendingValidation = Number(db.exec(`SELECT COUNT(*) FROM bookmark_processing`)[0]?.values?.[0]?.[0] ?? 0);
      db.run(
        `INSERT INTO sync_state(key, value, updated_at)
         VALUES ('legacy_migration_v1', 'done', ?)
         ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = excluded.updated_at`,
        [nowIso()],
      );
    }

    return {
      seededFromCache,
      processingRowsCreated,
      mediaTargetsBackfilled,
      linkTargetsBackfilled,
      bookmarksPendingValidation,
    };
  } finally {
    db.close();
  }
}

export async function processBookmark(bookmarkId: string, options: {
  delayMs?: number;
  maxBytes?: number;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  runtime?: ProcessorRuntime;
  force?: boolean;
  githubOnly?: boolean;
} = {}): Promise<ProcessBookmarkResult> {
  const runtime = options.runtime ?? await buildRuntime({
    delayMs: options.delayMs,
    maxBytes: options.maxBytes,
    chromeUserDataDir: options.chromeUserDataDir,
    chromeProfileDirectory: options.chromeProfileDirectory,
  });
  const db = runtime.db;
  ensureDbSchema(db);

  try {
    const initialRow = loadBookmarkRow(db, bookmarkId);
    if (!initialRow) {
      throw new Error(`Unknown bookmark: ${bookmarkId}`);
    }

    if (options.force) {
      markBookmarkPendingValidation(db, bookmarkId, 'forced_reprocess');
    }

    if (!canClaimBookmark(db, bookmarkId, runtime.claimOwner)) {
      return {
        bookmarkId,
        processingState: 'complete',
        skipped: true,
        textUpdated: false,
        threadTweetsStored: 0,
        mediaDownloaded: 0,
        mediaPending: 0,
        linksFetched: 0,
        linksPending: 0,
        authorHandle: initialRow.authorHandle,
        url: initialRow.url,
      };
    }

    setBookmarkInProgress(db, bookmarkId, runtime.claimOwner);

    let focalTweet: BookmarkRecord | null = null;
    let quotedTweet: BookmarkRecord | null = null;
    let conversationTweets: ThreadTweetRecord[] = [];
    let textUpdated = false;
    let threadTweetsStored = 0;

    try {
      const combined = await fetchTweetDetailCombined(
        initialRow.tweetId,
        initialRow.conversationId ?? initialRow.tweetId,
        runtime.csrfToken,
        runtime.tweetDetailQueryId,
        runtime.cookieHeader,
      );
      focalTweet = combined.focalTweet;
      quotedTweet = combined.quotedTweet;
      conversationTweets = deriveConversationTweets(combined.focalTweet, combined.threadTweets);

      if (focalTweet) {
        const previousText = initialRow.text;
        upsertBookmarkRecord(db, focalTweet, { markPendingOnChange: false });
        textUpdated = focalTweet.text !== previousText;
      }

      if (quotedTweet) {
        upsertBookmarkRecord(db, quotedTweet, { markPendingOnChange: false });
      }

      // Fetch and attach article bodies for focal and quoted tweets. Replies
      // are intentionally skipped — we only care about the bookmarked tweet
      // itself and what it quotes.
      await fetchAndStoreArticles(db, runtime, focalTweet, quotedTweet);

      if (conversationTweets.length > 0) {
        const conversationId = conversationTweets[0].conversationId ?? initialRow.conversationId ?? initialRow.tweetId;
        db.run(`DELETE FROM thread_tweets WHERE conversation_id = ?`, [conversationId]);
        for (const tweet of conversationTweets) {
          insertThreadTweet(db, tweet);
        }
        threadTweetsStored = conversationTweets.length;
      }

      db.run(
        `UPDATE bookmark_processing
         SET core_status = 'complete',
             thread_status = ?,
             updated_at = ?
         WHERE bookmark_id = ?`,
        [conversationTweets.length > 0 ? 'complete' : 'incomplete', nowIso(), bookmarkId],
      );
      if (conversationTweets.length === 0) {
        const failure: FailureState = {
          step: 'thread',
          code: 'thread_missing',
          message: 'TweetDetail returned no conversation tweets for this bookmark',
          retryable: false,
        };
        updateStepFailure(db, bookmarkId, failure);
        logFailureEvent(db, bookmarkId, failure, { targetKind: 'bookmark', targetRef: initialRow.url });
      }
    } catch (error) {
      const failure = classifyTwitterFailure(error, 'core');
      updateStepFailure(db, bookmarkId, failure);
      logFailureEvent(db, bookmarkId, failure, { targetKind: 'bookmark', targetRef: initialRow.url });
      db.run(
        `UPDATE bookmark_processing
         SET core_status = 'incomplete',
             thread_status = 'incomplete',
             processing_state = ?,
             next_retry_at = CASE WHEN ? THEN ? ELSE NULL END,
             claimed_at = NULL,
             claim_owner = NULL,
             updated_at = ?
         WHERE bookmark_id = ?`,
        [
          failure.retryable ? 'retryable_failed' : 'terminal_incomplete',
          failure.retryable ? 1 : 0,
          failure.retryable ? new Date(Date.now() + RETRY_DELAY_MS).toISOString() : null,
          nowIso(),
          bookmarkId,
        ],
      );
      return {
        bookmarkId,
        processingState: failure.retryable ? 'retryable_failed' : 'terminal_incomplete',
        skipped: false,
        textUpdated: false,
        threadTweetsStored: 0,
        mediaDownloaded: 0,
        mediaPending: 0,
        linksFetched: 0,
        linksPending: 0,
        authorHandle: initialRow.authorHandle,
        url: initialRow.url,
        lastError: `${failure.step}/${failure.code}: ${failure.message}`,
      };
    }

    const bookmark = loadBookmarkRow(db, bookmarkId);
    if (!bookmark) {
      throw new Error(`Bookmark disappeared during processing: ${bookmarkId}`);
    }

    const mediaSources: MediaSourceTweet[] = [];
    if (focalTweet) {
      mediaSources.push(focalTweet);
    } else {
      // TweetDetail didn't return the focal (rare — API glitch, deleted tweet).
      // Fall back to whatever we persisted for the bookmark row so stored
      // mediaObjects still drive media target discovery.
      mediaSources.push({
        tweetId: bookmark.tweetId,
        media: bookmark.media,
        mediaObjects: bookmark.mediaObjects,
      });
    }
    if (quotedTweet) mediaSources.push(quotedTweet);
    syncMediaTargets(db, bookmarkId, deriveExpectedMediaTargets(bookmarkId, mediaSources));
    syncLinkTargets(db, bookmarkId, deriveExpectedLinkTargets(bookmarkId, focalTweet, conversationTweets));

    const mediaResult = await processMediaTargets(db, runtime, bookmark);
    if (runtime.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, runtime.delayMs));
    }
    const linkResult = await processLinkTargets(db, runtime, bookmarkId, {
      githubOnly: options.githubOnly,
    });

    const processingState = validateBookmark(db, bookmarkId);
    releaseClaim(db, bookmarkId);

    let lastError: string | undefined;
    if (processingState !== 'complete') {
      const errRow = db.exec(
        `SELECT last_error_step, last_error_code, last_error_message FROM bookmark_processing WHERE bookmark_id = ?`,
        [bookmarkId],
      )[0]?.values?.[0];
      if (errRow) {
        const parts = [errRow[0], errRow[1]].filter(Boolean).join('/');
        lastError = parts ? `${parts}: ${errRow[2] ?? ''}`.trim() : (errRow[2] as string) ?? undefined;
      }
    }

    return {
      bookmarkId,
      processingState,
      skipped: false,
      textUpdated,
      threadTweetsStored,
      mediaDownloaded: mediaResult.downloaded,
      mediaPending: mediaResult.pending,
      linksFetched: linkResult.fetched,
      linksPending: linkResult.pending,
      authorHandle: bookmark.authorHandle,
      url: bookmark.url,
      lastError,
    };
  } finally {
    if (!options.runtime) {
      runtime.db.close();
    }
  }
}

export async function reprocessBookmarks(options: BatchProcessOptions = {}): Promise<BatchProcessResult> {
  const runtime = await buildRuntime({
    delayMs: options.delayMs,
    maxBytes: options.maxBytes,
    chromeUserDataDir: options.chromeUserDataDir,
    chromeProfileDirectory: options.chromeProfileDirectory,
  });

  try {
    return await reprocessBookmarksWithRuntime(runtime, options);
  } finally {
    runtime.db.close();
  }
}

export async function retryBookmarks(options: RetryBookmarksOptions = {}): Promise<RetryBookmarksResult> {
  const result = await reprocessBookmarks({
    step: 'all',
    bookmarkIds: options.bookmarkIds,
    includeTerminal: options.includeTerminal,
    delayMs: options.delayMs,
    maxBytes: options.maxBytes,
    chromeUserDataDir: options.chromeUserDataDir,
    chromeProfileDirectory: options.chromeProfileDirectory,
    onBookmarkResult: options.onBookmarkResult,
  });
  return {
    processed: result.processed,
    completed: result.completed,
    retryableFailed: result.retryableFailed,
    terminalIncomplete: result.terminalIncomplete,
    skipped: result.skipped,
  };
}

export async function syncBookmarksSequentially(options: SyncEngineOptions = {}): Promise<SyncEngineResult> {
  options.onProgress?.({
    page: 0,
    discovered: 0,
    processed: 0,
    completed: 0,
    retryableFailed: 0,
    terminalIncomplete: 0,
    skipped: 0,
    stage: 'preparing',
    detail: 'loading local state and Chrome session',
    running: true,
    done: false,
  });

  await migrateLegacyData();
  const runtime = await (options.runtimeFactory ?? buildRuntime)({
    delayMs: options.delayMs,
    maxBytes: options.maxBytes,
    chromeUserDataDir: options.chromeUserDataDir,
    chromeProfileDirectory: options.chromeProfileDirectory,
    includeDiscovery: true,
    folderId: options.folderId,
  });
  const pageFetcher = options.pageFetcher ?? fetchBookmarkTimelinePage;

  const incremental = options.incremental ?? true;
  const maxPages = options.maxPages ?? 500;
  const maxMinutes = options.maxMinutes ?? 30;
  const started = Date.now();
  const newestKnownId = incremental ? await getNewestStoredBookmarkId() : null;

  let page = 0;
  let cursor: string | undefined;
  let discovered = 0;
  let processed = 0;
  let completed = 0;
  let retryableFailed = 0;
  let terminalIncomplete = 0;
  let skipped = 0;
  let stopReason = 'completed';

  try {
    options.onProgress?.({
      page,
      discovered,
      processed,
      completed,
      retryableFailed,
      terminalIncomplete,
      skipped,
      stage: 'resuming',
      detail: 'resuming incomplete backlog',
      running: true,
      done: false,
    });

    const resumed = await reprocessBookmarksWithRuntime(runtime, {
      step: 'all',
      delayMs: options.delayMs,
      maxBytes: options.maxBytes,
      onProgress: (status) => {
        options.onProgress?.({
          page,
          discovered,
          processed: status.processed,
          completed: status.completed,
          retryableFailed: status.retryableFailed,
          terminalIncomplete: status.terminalIncomplete,
          skipped: status.skipped,
          stage: 'resuming',
          detail: status.total > 0
            ? `resuming incomplete backlog ${status.processed + status.skipped}/${status.total}`
            : 'no incomplete backlog',
          running: status.running,
          done: status.done,
          stopReason: status.stopReason,
        });
      },
    });
    processed += resumed.processed;
    completed += resumed.completed;
    retryableFailed += resumed.retryableFailed;
    terminalIncomplete += resumed.terminalIncomplete;
    skipped += resumed.skipped;

    while (page < maxPages) {
      if (Date.now() - started > maxMinutes * 60_000) {
        stopReason = 'max runtime reached';
        break;
      }

      options.onProgress?.({
        page: page + 1,
        discovered,
        processed,
        completed,
        retryableFailed,
        terminalIncomplete,
        skipped,
        stage: 'fetching',
        detail: options.folderId ? 'fetching new folder posts' : 'fetching new bookmarks',
        running: true,
        done: false,
      });

      const pageResult: PageResult = await pageFetcher({
        csrfToken: runtime.csrfToken,
        queryId: runtime.bookmarksQueryId ?? '',
        cursor,
        cookieHeader: runtime.cookieHeader,
        folderId: options.folderId,
        folderQueryId: runtime.folderQueryId,
      });
      page += 1;

      if (pageResult.records.length === 0 && !pageResult.nextCursor) {
        stopReason = 'end of bookmarks';
        break;
      }

      let reachedLatestStored = false;

      for (const record of pageResult.records) {
        const upserted = upsertBookmarkRecord(runtime.db, record);
        discovered += upserted.inserted ? 1 : 0;
        if (newestKnownId && record.id === newestKnownId) {
          reachedLatestStored = true;
        }

        const stateRow = runtime.db.exec(
          `SELECT processing_state, requires_revalidation
           FROM bookmark_processing
           WHERE bookmark_id = ?`,
          [record.id],
        )[0]?.values?.[0];
        const state = (stateRow?.[0] as BookmarkProcessingState | undefined) ?? 'pending';
        const requiresRevalidation = Boolean(stateRow?.[1]);
        const shouldProcess = requiresRevalidation || state === 'pending' || state === 'retryable_failed';
        if (!shouldProcess) {
          skipped++;
          continue;
        }

        options.onProgress?.({
          page,
          discovered,
          processed,
          completed,
          retryableFailed,
          terminalIncomplete,
          skipped,
          stage: 'processing',
          detail: record.authorHandle ? `processing @${record.authorHandle}` : 'processing bookmark',
          running: true,
          done: false,
        });

        const result = await processBookmark(record.id, { runtime });
        if (!result.skipped) processed++;
        if (result.processingState === 'complete') completed++;
        else if (result.processingState === 'retryable_failed') retryableFailed++;
        else if (result.processingState === 'terminal_incomplete') terminalIncomplete++;

        if (options.targetAdds && discovered >= options.targetAdds) {
          stopReason = 'target additions reached';
          break;
        }
      }

      options.onProgress?.({
        page,
        discovered,
        processed,
        completed,
        retryableFailed,
        terminalIncomplete,
        skipped,
        running: true,
        done: false,
      });

      if (stopReason === 'target additions reached') break;
      if (incremental && reachedLatestStored) {
        stopReason = 'caught up to newest stored bookmark';
        break;
      }
      if (!pageResult.nextCursor) {
        stopReason = 'end of bookmarks';
        break;
      }

      cursor = pageResult.nextCursor;
      if (page < maxPages && runtime.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, runtime.delayMs));
      }
    }

    options.onProgress?.({
      page,
      discovered,
      processed,
      completed,
      retryableFailed,
      terminalIncomplete,
      skipped,
      stage: 'completed',
      detail: stopReason,
      running: false,
      done: true,
      stopReason,
    });

    return {
      pages: page,
      discovered,
      processed,
      completed,
      retryableFailed,
      terminalIncomplete,
      skipped,
      stopReason,
    };
  } finally {
    runtime.db.close();
  }
}
