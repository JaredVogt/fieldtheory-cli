import { ensureDataDir, threadSyncStatePath } from './paths.js';
import { loadChromeSessionConfig } from './config.js';
import { extractChromeXCookies } from './chrome-cookies.js';
import { readJson, writeJson, pathExists } from './fs.js';
import { openDb, saveDb } from './db.js';
import { twitterBookmarksIndexPath } from './paths.js';
import {
  GRAPHQL_FEATURES,
  buildHeaders,
  fetchWithRetry,
  convertTweetToRecord,
} from './graphql-bookmarks.js';
import { getQueryId } from './graphql-query-ids.js';
import { insertThreadTweet } from './bookmarks-db.js';
import type { BookmarkRecord, ThreadTweetRecord, ThreadSyncState } from './types.js';

// ── TweetDetail endpoint ──────────────────────────────────────────────────

const TWEET_DETAIL_OPERATION = 'TweetDetail';

export function buildTweetDetailUrl(queryId: string, focalTweetId: string): string {
  const variables = {
    focalTweetId,
    with_rux_injections: false,
    rankingMode: 'Relevance',
    includePromotedContent: true,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true,
  };
  const fieldToggles = {
    withArticlePlainText: false,
    withArticleRichContentState: true,
    withAuxiliaryUserLabels: false,
    withGrokAnalyze: false,
  };
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(GRAPHQL_FEATURES),
    fieldToggles: JSON.stringify(fieldToggles),
  });
  return `https://x.com/i/api/graphql/${queryId}/${TWEET_DETAIL_OPERATION}?${params}`;
}

// ── Response parsing ──────────────────────────────────────────────────────

export function extractTweetResults(entries: any[]): any[] {
  const results: any[] = [];
  for (const entry of entries) {
    const entryId = entry?.entryId ?? '';

    // Single tweet entry (the focal tweet or standalone replies)
    if (entryId.startsWith('tweet-')) {
      const tweetResult = entry?.content?.itemContent?.tweet_results?.result;
      if (tweetResult) results.push(tweetResult);
      continue;
    }

    // Conversation thread module — contains nested items
    if (entryId.startsWith('conversationthread-')) {
      const items = entry?.content?.items ?? [];
      for (const item of items) {
        const tweetResult = item?.item?.itemContent?.tweet_results?.result;
        if (tweetResult) results.push(tweetResult);
      }
      continue;
    }
  }
  return results;
}

export function parseTweetDetailResponse(
  json: any,
  targetConversationId: string,
  now: string,
): ThreadTweetRecord[] {
  // Walk all instructions to find entries
  const instructions =
    json?.data?.tweetResult?.result?.timeline?.timeline?.instructions ??
    json?.data?.threaded_conversation_with_injections_v2?.instructions ??
    [];

  const entries: any[] = [];
  for (const inst of instructions) {
    if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
      entries.push(...inst.entries);
    }
    // Module items can also appear directly
    if (inst.type === 'TimelineAddToModule' && Array.isArray(inst.moduleItems)) {
      for (const item of inst.moduleItems) {
        const tweetResult = item?.item?.itemContent?.tweet_results?.result;
        if (tweetResult) entries.push({ entryId: 'tweet-inline', content: { itemContent: { tweet_results: { result: tweetResult } } } });
      }
    }
  }

  const tweetResults = extractTweetResults(entries);

  // Convert to BookmarkRecord first (reuse existing parser), then map to ThreadTweetRecord
  const records: { record: BookmarkRecord; snowflake: bigint }[] = [];
  const seen = new Set<string>();

  for (const tweetResult of tweetResults) {
    const record = convertTweetToRecord(tweetResult, now);
    if (!record) continue;
    if (seen.has(record.tweetId)) continue;

    // Filter to only tweets in the target conversation
    if (record.conversationId && record.conversationId !== targetConversationId) continue;

    seen.add(record.tweetId);
    const snowflake = parseTweetSnowflake(record.tweetId);
    if (snowflake !== null) {
      records.push({ record, snowflake });
    }
  }

  // Sort chronologically by snowflake ID
  records.sort((a, b) => (a.snowflake < b.snowflake ? -1 : a.snowflake > b.snowflake ? 1 : 0));

  // Map to ThreadTweetRecord with position
  return records.map(({ record }, i) => ({
    id: record.tweetId,
    tweetId: record.tweetId,
    conversationId: targetConversationId,
    url: record.url,
    text: record.text,
    authorHandle: record.authorHandle,
    authorName: record.authorName,
    authorProfileImageUrl: record.authorProfileImageUrl,
    postedAt: record.postedAt,
    syncedAt: record.syncedAt,
    inReplyToStatusId: record.inReplyToStatusId,
    language: record.language,
    threadPosition: i,
    isRoot: i === 0,
    parentTweetId: record.inReplyToStatusId,
    engagement: record.engagement,
    media: record.media,
    links: record.links,
  }));
}

function parseTweetSnowflake(value?: string | null): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

// ── Fetch a single thread ─────────────────────────────────────────────────

async function fetchThread(
  conversationId: string,
  csrfToken: string,
  queryId: string,
  cookieHeader?: string,
): Promise<ThreadTweetRecord[]> {
  const url = buildTweetDetailUrl(queryId, conversationId);
  const json = await fetchWithRetry(url, buildHeaders(csrfToken, cookieHeader), 'TweetDetail');
  return parseTweetDetailResponse(json, conversationId, new Date().toISOString());
}

// ── Combined fetch: text refresh + thread in one API call ────────────────

export async function fetchTweetDetailCombined(
  tweetId: string,
  conversationId: string,
  csrfToken: string,
  queryId: string,
  cookieHeader?: string,
): Promise<{ focalTweet: BookmarkRecord | null; threadTweets: ThreadTweetRecord[] }> {
  const url = buildTweetDetailUrl(queryId, tweetId);
  const json = await fetchWithRetry(url, buildHeaders(csrfToken, cookieHeader), 'TweetDetail');
  const now = new Date().toISOString();

  // Extract thread tweets (all tweets in the conversation)
  const threadTweets = parseTweetDetailResponse(json, conversationId, now);

  // Extract focal tweet for text refresh + media data
  const instructions =
    json?.data?.tweetResult?.result?.timeline?.timeline?.instructions ??
    json?.data?.threaded_conversation_with_injections_v2?.instructions ??
    [];
  const entries: any[] = [];
  for (const inst of instructions) {
    if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
      entries.push(...inst.entries);
    }
  }
  const tweetResults = extractTweetResults(entries);
  const focalTweet = tweetResults
    .map((tr: any) => convertTweetToRecord(tr, now))
    .find((r: BookmarkRecord | null) => r && r.tweetId === tweetId) ?? null;

  return { focalTweet, threadTweets };
}

// ── Sync orchestrator ─────────────────────────────────────────────────────

export interface ThreadSyncOptions {
  delayMs?: number;
  maxThreads?: number;
  maxMinutes?: number;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  csrfToken?: string;
  cookieHeader?: string;
  onProgress?: (status: ThreadSyncProgress) => void;
}

export interface ThreadSyncProgress {
  threadsProcessed: number;
  threadsTotal: number;
  tweetsAdded: number;
  running: boolean;
  done: boolean;
}

export interface ThreadSyncResult {
  threadsProcessed: number;
  tweetsAdded: number;
  skipped: number;
  failed: number;
  stopReason: string;
}

export async function syncThreads(options: ThreadSyncOptions = {}): Promise<ThreadSyncResult> {
  const delayMs = options.delayMs ?? 600;
  const maxMinutes = options.maxMinutes ?? 15;

  // Resolve query ID (auto-extracted from X's JS bundle)
  const tweetDetailQueryId = await getQueryId('TweetDetail');

  // Resolve auth
  let csrfToken: string;
  let cookieHeader: string | undefined;

  if (options.csrfToken) {
    csrfToken = options.csrfToken;
    cookieHeader = options.cookieHeader;
  } else {
    const chromeConfig = loadChromeSessionConfig();
    const chromeDir = options.chromeUserDataDir ?? chromeConfig.chromeUserDataDir;
    const chromeProfile = options.chromeProfileDirectory ?? chromeConfig.chromeProfileDirectory;
    const cookies = extractChromeXCookies(chromeDir, chromeProfile);
    csrfToken = cookies.csrfToken;
    cookieHeader = cookies.cookieHeader;
  }

  ensureDataDir();

  // Open DB and find unfetched conversation bookmarks
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);

  try {
    // Ensure thread tables exist
    db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const hasThreadTable = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='thread_tweets'"
    );
    if (!hasThreadTable.length || !hasThreadTable[0].values.length) {
      // Need to run initSchema or at least create thread tables
      // They should already exist from buildIndex, but handle the edge case
      db.run(`CREATE TABLE IF NOT EXISTS thread_tweets (
        id TEXT PRIMARY KEY, tweet_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        url TEXT NOT NULL, text TEXT NOT NULL, author_handle TEXT, author_name TEXT,
        author_profile_image_url TEXT, posted_at TEXT, synced_at TEXT NOT NULL,
        in_reply_to_status_id TEXT, parent_tweet_id TEXT,
        thread_position INTEGER NOT NULL, is_root INTEGER NOT NULL DEFAULT 0,
        language TEXT, like_count INTEGER, repost_count INTEGER, reply_count INTEGER,
        view_count INTEGER, media_count INTEGER DEFAULT 0, link_count INTEGER DEFAULT 0,
        links_json TEXT
      )`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_thread_conversation ON thread_tweets(conversation_id)`);
      db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS thread_fts USING fts5(
        text, author_handle, author_name,
        content=thread_tweets, content_rowid=rowid,
        tokenize='porter unicode61'
      )`);
    }

    // Ensure thread_fetched column exists
    try { db.run('ALTER TABLE bookmarks ADD COLUMN thread_fetched INTEGER DEFAULT 0'); } catch { /* exists */ }

    // Find bookmarks needing thread fetch
    const unfetched = db.exec(`
      SELECT id, conversation_id FROM bookmarks
      WHERE conversation_id IS NOT NULL
        AND thread_fetched = 0
    `);

    if (!unfetched.length || !unfetched[0].values.length) {
      options.onProgress?.({ threadsProcessed: 0, threadsTotal: 0, tweetsAdded: 0, running: false, done: true });
      return { threadsProcessed: 0, tweetsAdded: 0, skipped: 0, failed: 0, stopReason: 'no unfetched threads' };
    }

    // Deduplicate by conversation_id
    const conversationMap = new Map<string, string[]>(); // conversationId → [bookmarkIds]
    for (const row of unfetched[0].values) {
      const bookmarkId = row[0] as string;
      const convId = row[1] as string;
      if (!conversationMap.has(convId)) conversationMap.set(convId, []);
      conversationMap.get(convId)!.push(bookmarkId);
    }

    // Load state for retry tracking
    const statePath = threadSyncStatePath();
    const prevState: ThreadSyncState = (await pathExists(statePath))
      ? await readJson<ThreadSyncState>(statePath)
      : { totalRuns: 0, totalThreadsFetched: 0, failedConversationIds: [] };

    const conversationIds = Array.from(conversationMap.keys());
    const maxThreads = options.maxThreads ?? conversationIds.length;
    const total = Math.min(conversationIds.length, maxThreads);

    const started = Date.now();
    let processed = 0;
    let totalTweetsAdded = 0;
    let failed = 0;
    let stopReason = 'completed';
    const newFailedIds: string[] = [];

    for (let i = 0; i < total; i++) {
      if (Date.now() - started > maxMinutes * 60_000) {
        stopReason = 'max runtime reached';
        break;
      }

      const convId = conversationIds[i];

      try {
        const tweets = await fetchThread(convId, csrfToken, tweetDetailQueryId, cookieHeader);

        if (tweets.length > 0) {
          db.run('BEGIN TRANSACTION');
          for (const tweet of tweets) {
            insertThreadTweet(db, tweet);
          }
          // Mark all bookmarks in this conversation as fetched
          db.run(`UPDATE bookmarks SET thread_fetched = 1 WHERE conversation_id = ?`, [convId]);
          db.run('COMMIT');
          totalTweetsAdded += tweets.length;
        } else {
          // No thread tweets found — mark as fetched anyway (standalone tweet or deleted)
          db.run(`UPDATE bookmarks SET thread_fetched = 1 WHERE conversation_id = ?`, [convId]);
        }

        processed++;
      } catch (err) {
        const msg = (err as Error).message;
        // 404 or 403 = deleted/protected, mark as fetched (-1 would be ideal but just use 1)
        if (msg.includes('returned 404') || msg.includes('returned 403')) {
          db.run(`UPDATE bookmarks SET thread_fetched = 1 WHERE conversation_id = ?`, [convId]);
        } else {
          newFailedIds.push(convId);
        }
        failed++;
      }

      // Save to disk after each thread so progress survives crashes/kills
      await saveDb(db, dbPath);

      options.onProgress?.({
        threadsProcessed: processed + failed,
        threadsTotal: total,
        tweetsAdded: totalTweetsAdded,
        running: true,
        done: false,
      });

      // Rate limiting delay
      if (i < total - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // Rebuild FTS index for threads
    if (totalTweetsAdded > 0) {
      db.run(`INSERT INTO thread_fts(thread_fts) VALUES('rebuild')`);
    }

    saveDb(db, dbPath);

    // Save state
    const updatedFailedIds = [
      ...prevState.failedConversationIds.filter((id) => !conversationMap.has(id)),
      ...newFailedIds,
    ];
    await writeJson(statePath, {
      lastRunAt: new Date().toISOString(),
      totalRuns: prevState.totalRuns + 1,
      totalThreadsFetched: prevState.totalThreadsFetched + processed,
      failedConversationIds: updatedFailedIds,
    } satisfies ThreadSyncState);

    options.onProgress?.({
      threadsProcessed: processed + failed,
      threadsTotal: total,
      tweetsAdded: totalTweetsAdded,
      running: false,
      done: true,
    });

    return {
      threadsProcessed: processed,
      tweetsAdded: totalTweetsAdded,
      skipped: conversationIds.length - total,
      failed,
      stopReason,
    };
  } finally {
    db.close();
  }
}

// ── Refresh bookmark text via TweetDetail ────────────────────────────────

export interface RefreshProgress {
  processed: number;
  total: number;
  updated: number;
  running: boolean;
  done: boolean;
}

export interface RefreshOptions {
  delayMs?: number;
  maxMinutes?: number;
  force?: boolean;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  csrfToken?: string;
  cookieHeader?: string;
  onProgress?: (status: RefreshProgress) => void;
}

export interface RefreshResult {
  processed: number;
  updated: number;
  failed: number;
  stopReason: string;
}

/**
 * Re-fetch each bookmark via TweetDetail to pick up full note_tweet text
 * and update the DB where the fetched text is longer than what's stored.
 */
export async function refreshBookmarkText(options: RefreshOptions = {}): Promise<RefreshResult> {
  const delayMs = options.delayMs ?? 600;
  const maxMinutes = options.maxMinutes ?? 30;

  const tweetDetailQueryId = await getQueryId('TweetDetail');

  // Resolve auth
  let csrfToken: string;
  let cookieHeader: string | undefined;

  if (options.csrfToken) {
    csrfToken = options.csrfToken;
    cookieHeader = options.cookieHeader;
  } else {
    const chromeConfig = loadChromeSessionConfig();
    const chromeDir = options.chromeUserDataDir ?? chromeConfig.chromeUserDataDir;
    const chromeProfile = options.chromeProfileDirectory ?? chromeConfig.chromeProfileDirectory;
    const cookies = extractChromeXCookies(chromeDir, chromeProfile);
    csrfToken = cookies.csrfToken;
    cookieHeader = cookies.cookieHeader;
  }

  ensureDataDir();
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);

  try {
    // Ensure text_refreshed column exists (migration may not have run yet)
    try { db.run('ALTER TABLE bookmarks ADD COLUMN text_refreshed INTEGER DEFAULT 0'); } catch { /* already exists */ }

    // Get bookmark tweet IDs and their current text (skip already-refreshed unless --force)
    const query = options.force
      ? 'SELECT tweet_id, text FROM bookmarks'
      : 'SELECT tweet_id, text FROM bookmarks WHERE text_refreshed = 0';
    const rows = db.exec(query);
    if (!rows.length || !rows[0].values.length) {
      options.onProgress?.({ processed: 0, total: 0, updated: 0, running: false, done: true });
      return { processed: 0, updated: 0, failed: 0, stopReason: 'no bookmarks' };
    }

    const bookmarks = rows[0].values as [string, string][];
    const total = bookmarks.length;
    const started = Date.now();
    let processed = 0;
    let updated = 0;
    let failed = 0;
    let stopReason = 'completed';

    for (let i = 0; i < total; i++) {
      if (Date.now() - started > maxMinutes * 60_000) {
        stopReason = 'max runtime reached';
        break;
      }

      const [tweetId, currentText] = bookmarks[i];

      try {
        const url = buildTweetDetailUrl(tweetDetailQueryId, tweetId);
        const json = await fetchWithRetry(url, buildHeaders(csrfToken, cookieHeader), 'TweetDetail');

        // Extract the focal tweet from TweetDetail response
        const instructions =
          json?.data?.tweetResult?.result?.timeline?.timeline?.instructions ??
          json?.data?.threaded_conversation_with_injections_v2?.instructions ??
          [];

        const entries: any[] = [];
        for (const inst of instructions) {
          if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
            entries.push(...inst.entries);
          }
        }

        const tweetResults = extractTweetResults(entries);
        const now = new Date().toISOString();

        const record = tweetResults
          .map((tr: any) => convertTweetToRecord(tr, now))
          .find((r: BookmarkRecord | null) => r && r.tweetId === tweetId);

        if (record && record.text.length > currentText.length) {
          db.run(
            'UPDATE bookmarks SET text = ?, links_json = ?, link_count = ?, text_refreshed = 1 WHERE tweet_id = ?',
            [record.text, record.links?.length ? JSON.stringify(record.links) : null, record.links?.length ?? 0, tweetId],
          );
          updated++;
        } else {
          db.run('UPDATE bookmarks SET text_refreshed = 1 WHERE tweet_id = ?', [tweetId]);
        }

        processed++;
      } catch {
        failed++;
      }

      // Save periodically (every 10 tweets)
      if ((i + 1) % 10 === 0) {
        saveDb(db, dbPath);
      }

      options.onProgress?.({
        processed: processed + failed,
        total,
        updated,
        running: true,
        done: false,
      });

      if (i < total - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // Rebuild FTS after updates
    if (updated > 0) {
      db.run(`INSERT INTO bookmarks_fts(bookmarks_fts) VALUES('rebuild')`);
    }

    saveDb(db, dbPath);

    options.onProgress?.({
      processed: processed + failed,
      total,
      updated,
      running: false,
      done: true,
    });

    return { processed, updated, failed, stopReason };
  } finally {
    db.close();
  }
}
