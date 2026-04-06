import { openDb, saveDb } from './db.js';
import { ensureDataDir, twitterBookmarksIndexPath, twitterBookmarksCachePath, bookmarkMediaDir, bookmarkMediaManifestPath } from './paths.js';
import { loadChromeSessionConfig } from './config.js';
import { extractChromeXCookies } from './chrome-cookies.js';
import { getQueryId } from './graphql-query-ids.js';
import { fetchTweetDetailCombined } from './graphql-threads.js';
import { insertThreadTweet } from './bookmarks-db.js';
import { downloadMediaForBookmark, resolveMediaUrls, loadManifest } from './bookmark-media.js';
import type { MediaFetchEntry } from './bookmark-media.js';
import { ensureLinkContentSchema, fetchLinksForBookmark } from './fetch-links.js';
import { ensureDir, readJsonLines, writeJson } from './fs.js';
import type { BookmarkRecord } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface HydrateOptions {
  delayMs?: number;
  maxMinutes?: number;
  maxBytes?: number;
  skipRefresh?: boolean;
  skipThreads?: boolean;
  skipMedia?: boolean;
  skipLinks?: boolean;
  force?: boolean;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  onProgress?: (status: HydrateProgress) => void;
}

export interface HydrateProgress {
  bookmarksProcessed: number;
  bookmarksTotal: number;
  textsUpdated: number;
  threadsAdded: number;
  mediaDownloaded: number;
  linksFetched: number;
  running: boolean;
  done: boolean;
}

export interface HydrateResult {
  bookmarksProcessed: number;
  textsUpdated: number;
  threadsProcessed: number;
  tweetsAdded: number;
  mediaDownloaded: number;
  mediaFailed: number;
  linksFetched: number;
  linksFailed: number;
  stopReason: string;
}

// ── Main orchestrator ────────────────────────────────────────────────────

export async function hydratePerBookmark(options: HydrateOptions = {}): Promise<HydrateResult> {
  const delayMs = options.delayMs ?? 600;
  const maxMinutes = options.maxMinutes ?? 60;
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const skipRefresh = options.skipRefresh ?? false;
  const skipThreads = options.skipThreads ?? false;
  const skipMedia = options.skipMedia ?? false;
  const skipLinks = options.skipLinks ?? false;

  ensureDataDir();

  // 1. Resolve auth ONCE
  let csrfToken: string | undefined;
  let cookieHeader: string | undefined;
  let tweetDetailQueryId: string | undefined;

  const needsTwitterApi = !skipRefresh || !skipThreads;
  if (needsTwitterApi) {
    const chromeConfig = loadChromeSessionConfig();
    const chromeDir = options.chromeUserDataDir ?? chromeConfig.chromeUserDataDir;
    const chromeProfile = options.chromeProfileDirectory ?? chromeConfig.chromeProfileDirectory;
    const cookies = extractChromeXCookies(chromeDir, chromeProfile);
    csrfToken = cookies.csrfToken;
    cookieHeader = cookies.cookieHeader;
    tweetDetailQueryId = await getQueryId('TweetDetail');
  }

  const githubToken = process.env.GITHUB_TOKEN || undefined;

  // 2. Open DB once
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);

  try {
    // Ensure schemas
    db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    try { db.run('ALTER TABLE bookmarks ADD COLUMN text_refreshed INTEGER DEFAULT 0'); } catch {}
    try { db.run('ALTER TABLE bookmarks ADD COLUMN hydrated INTEGER DEFAULT 0'); } catch {}
    if (!skipLinks) ensureLinkContentSchema(db);

    // Ensure thread tables exist
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
    try { db.run('ALTER TABLE bookmarks ADD COLUMN thread_fetched INTEGER DEFAULT 0'); } catch {}

    // 3. Build JSONL media lookup if needed
    let jsonlMap: Map<string, BookmarkRecord> | undefined;
    if (!skipMedia) {
      const records = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
      jsonlMap = new Map(records.map((r) => [r.tweetId, r]));
    }

    // 4. Load media manifest for dedup
    const mediaDir = bookmarkMediaDir();
    if (!skipMedia) await ensureDir(mediaDir);
    const prevManifest = !skipMedia ? await loadManifest() : null;
    const mediaKeys = new Set((prevManifest?.entries ?? []).map((e) => `${e.bookmarkId}::${e.sourceUrl}`));
    const allMediaEntries: MediaFetchEntry[] = prevManifest?.entries ? [...prevManifest.entries] : [];

    // 5. Load link_content IDs for dedup
    const linkContentIds = new Set<string>();
    if (!skipLinks) {
      const lcRows = db.exec('SELECT id FROM link_content');
      if (lcRows.length) {
        for (const r of lcRows[0].values) linkContentIds.add(r[0] as string);
      }
    }

    // 6. Query bookmarks needing work
    const query = options.force
      ? `SELECT id, tweet_id, conversation_id, text, media_count, links_json, github_urls,
                text_refreshed, thread_fetched, author_handle, author_name, author_profile_image_url, url
         FROM bookmarks`
      : `SELECT id, tweet_id, conversation_id, text, media_count, links_json, github_urls,
                text_refreshed, thread_fetched, author_handle, author_name, author_profile_image_url, url
         FROM bookmarks WHERE hydrated = 0`;

    const rows = db.exec(query);
    if (!rows.length || !rows[0].values.length) {
      options.onProgress?.({ bookmarksProcessed: 0, bookmarksTotal: 0, textsUpdated: 0, threadsAdded: 0, mediaDownloaded: 0, linksFetched: 0, running: false, done: true });
      return { bookmarksProcessed: 0, textsUpdated: 0, threadsProcessed: 0, tweetsAdded: 0, mediaDownloaded: 0, mediaFailed: 0, linksFetched: 0, linksFailed: 0, stopReason: 'all bookmarks hydrated' };
    }

    const bookmarks = rows[0].values;
    const total = bookmarks.length;
    const started = Date.now();
    let processed = 0;
    let textsUpdated = 0;
    let threadsProcessed = 0;
    let tweetsAdded = 0;
    let mediaDownloaded = 0;
    let mediaFailed = 0;
    let linksFetched = 0;
    let linksFailed = 0;
    let stopReason = 'completed';

    // 7. Per-bookmark loop
    for (let i = 0; i < total; i++) {
      if (Date.now() - started > maxMinutes * 60_000) {
        stopReason = 'max runtime reached';
        break;
      }

      const row = bookmarks[i];
      const id = row[0] as string;
      const tweetId = row[1] as string;
      const conversationId = row[2] as string | null;
      const currentText = row[3] as string;
      const mediaCount = row[4] as number;
      const linksJson = row[5] as string | null;
      const githubUrls = row[6] as string | null;
      const textRefreshed = row[7] as number;
      const threadFetched = row[8] as number;
      const authorHandle = row[9] as string | undefined;
      const authorName = row[10] as string | undefined;
      const authorProfileImageUrl = row[11] as string | undefined;
      const bookmarkUrl = row[12] as string;

      const needsRefresh = !skipRefresh && textRefreshed === 0;
      const needsThread = !skipThreads && threadFetched === 0 && conversationId != null;
      const needsMedia = !skipMedia && mediaCount > 0;
      const needsLinks = !skipLinks && (linksJson != null || githubUrls != null);

      let focalMediaObjects: any[] | undefined;
      let focalMedia: string[] | undefined;

      // (a) Combined TweetDetail: refresh text + fetch thread
      if (needsRefresh || needsThread) {
        try {
          const result = await fetchTweetDetailCombined(
            tweetId,
            conversationId ?? tweetId,
            csrfToken!,
            tweetDetailQueryId!,
            cookieHeader,
          );

          // Refresh text
          if (needsRefresh && result.focalTweet) {
            if (result.focalTweet.text.length > currentText.length) {
              db.run(
                'UPDATE bookmarks SET text = ?, links_json = ?, link_count = ?, text_refreshed = 1 WHERE id = ?',
                [result.focalTweet.text, result.focalTweet.links?.length ? JSON.stringify(result.focalTweet.links) : null, result.focalTweet.links?.length ?? 0, id],
              );
              textsUpdated++;
            } else {
              db.run('UPDATE bookmarks SET text_refreshed = 1 WHERE id = ?', [id]);
            }
            // Stash media data from the API response
            focalMediaObjects = result.focalTweet.mediaObjects;
            focalMedia = result.focalTweet.media;
          } else if (needsRefresh) {
            db.run('UPDATE bookmarks SET text_refreshed = 1 WHERE id = ?', [id]);
          }

          // Insert thread tweets
          if (needsThread && result.threadTweets.length > 0) {
            for (const tweet of result.threadTweets) {
              insertThreadTweet(db, tweet);
            }
            tweetsAdded += result.threadTweets.length;
            threadsProcessed++;
          }
          if (needsThread || needsRefresh) {
            db.run('UPDATE bookmarks SET thread_fetched = 1 WHERE id = ?', [id]);
          }

          // Rate limit delay for Twitter API
          await new Promise((r) => setTimeout(r, delayMs));
        } catch {
          // Mark as done even on failure to avoid infinite retries
          db.run('UPDATE bookmarks SET text_refreshed = 1, thread_fetched = 1 WHERE id = ?', [id]);
        }
      }

      // (b) Download media
      if (needsMedia) {
        // Get media data: prefer fresh API response, fall back to JSONL, fall back to nothing
        const jsonlRecord = jsonlMap?.get(tweetId);
        const mediaObjects = focalMediaObjects ?? (jsonlRecord?.mediaObjects as any) ?? undefined;
        const media = focalMedia ?? jsonlRecord?.media ?? undefined;
        const profileImg = authorProfileImageUrl ?? jsonlRecord?.authorProfileImageUrl;

        const mediaUrls = resolveMediaUrls(mediaObjects, media, profileImg, id, mediaKeys);
        if (mediaUrls.length > 0) {
          const result = await downloadMediaForBookmark(
            { id, tweetId, url: bookmarkUrl, authorHandle, authorName, authorProfileImageUrl: profileImg },
            mediaUrls, mediaKeys, mediaDir, maxBytes,
          );
          allMediaEntries.push(...result.entries);
          mediaDownloaded += result.downloaded;
          mediaFailed += result.failed;
        }
      }

      // (c) Fetch link content
      if (needsLinks) {
        const result = await fetchLinksForBookmark(db, id, linksJson, githubUrls, linkContentIds, {
          githubToken,
          delayMs: 300,
        });
        linksFetched += result.fetched;
        linksFailed += result.failed;
      }

      // (d) Mark as hydrated
      db.run('UPDATE bookmarks SET hydrated = 1 WHERE id = ?', [id]);

      // (e) Save to disk (crash safety)
      processed++;
      saveDb(db, dbPath);

      options.onProgress?.({
        bookmarksProcessed: processed,
        bookmarksTotal: total,
        textsUpdated,
        threadsAdded: threadsProcessed,
        mediaDownloaded,
        linksFetched,
        running: true,
        done: false,
      });
    }

    // 8. Rebuild FTS indexes once at end
    if (textsUpdated > 0) {
      db.run(`INSERT INTO bookmarks_fts(bookmarks_fts) VALUES('rebuild')`);
    }
    if (tweetsAdded > 0) {
      db.run(`INSERT INTO thread_fts(thread_fts) VALUES('rebuild')`);
    }
    if (linksFetched > 0) {
      const hasLcFts = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='link_content_fts'");
      if (hasLcFts.length && hasLcFts[0].values.length) {
        db.run(`INSERT INTO link_content_fts(link_content_fts) VALUES('rebuild')`);
      }
    }

    saveDb(db, dbPath);

    // 9. Save media manifest
    if (!skipMedia && allMediaEntries.length > (prevManifest?.entries?.length ?? 0)) {
      await writeJson(bookmarkMediaManifestPath(), {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        limit: total,
        maxBytes,
        processed: allMediaEntries.length - (prevManifest?.entries?.length ?? 0),
        downloaded: mediaDownloaded,
        skippedTooLarge: 0,
        failed: mediaFailed,
        entries: allMediaEntries,
      });
    }

    options.onProgress?.({
      bookmarksProcessed: processed,
      bookmarksTotal: total,
      textsUpdated,
      threadsAdded: threadsProcessed,
      mediaDownloaded,
      linksFetched,
      running: false,
      done: true,
    });

    return {
      bookmarksProcessed: processed,
      textsUpdated,
      threadsProcessed,
      tweetsAdded,
      mediaDownloaded,
      mediaFailed,
      linksFetched,
      linksFailed,
      stopReason,
    };
  } finally {
    db.close();
  }
}
