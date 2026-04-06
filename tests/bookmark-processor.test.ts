import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { bookmarkMediaDir, twitterBookmarksIndexPath } from '../src/paths.js';
import {
  buildIndex,
  ensureDbSchema,
  getBookmarkProcessing,
  listFailureEvents,
} from '../src/bookmarks-db.js';
import { openDb } from '../src/db.js';
import { ensureDir } from '../src/fs.js';
import { ensureLinkContentSchema } from '../src/fetch-links.js';
import {
  processBookmark,
  syncBookmarksSequentially,
  type ProcessorRuntime,
  type SyncEngineProgress,
} from '../src/bookmark-processor.js';

function makeTweetResult(
  id: string,
  text: string,
  options: {
    conversationId?: string;
    authorHandle?: string;
    authorName?: string;
    inReplyToStatusId?: string;
    mediaUrl?: string;
    links?: string[];
  } = {},
) {
  const conversationId = options.conversationId ?? id;
  const links = options.links ?? [];
  const mediaUrl = options.mediaUrl;
  return {
    rest_id: id,
    legacy: {
      id_str: id,
      full_text: text,
      created_at: 'Tue Mar 10 12:00:00 +0000 2026',
      conversation_id_str: conversationId,
      in_reply_to_status_id_str: options.inReplyToStatusId ?? null,
      entities: {
        urls: links.map((url, index) => ({ expanded_url: url, url: `https://t.co/${index}` })),
      },
      ...(mediaUrl
        ? {
            extended_entities: {
              media: [
                {
                  type: 'photo',
                  media_url_https: mediaUrl,
                  original_info: { width: 1200, height: 800 },
                },
              ],
            },
          }
        : {}),
    },
    core: {
      user_results: {
        result: {
          rest_id: 'user-1',
          core: {
            screen_name: options.authorHandle ?? 'alice',
            name: options.authorName ?? 'Alice',
          },
          legacy: {
            description: 'bio',
            followers_count: 1,
            friends_count: 1,
          },
        },
      },
    },
  };
}

function makeTweetDetailResponse(...tweets: any[]) {
  return {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          {
            type: 'TimelineAddEntries',
            entries: tweets.map((tweet) => ({
              entryId: `tweet-${tweet.rest_id}`,
              content: {
                itemContent: {
                  tweet_results: { result: tweet },
                },
              },
            })),
          },
        ],
      },
    },
  };
}

async function setupBookmarkFixture(recordOverrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ft-processor-'));
  process.env.FT_DATA_DIR = dir;

  const record = {
    id: '100',
    tweetId: '100',
    url: 'https://x.com/alice/status/100',
    text: 'short root text',
    authorHandle: 'alice',
    authorName: 'Alice',
    syncedAt: '2026-03-10T00:00:00Z',
    postedAt: '2026-03-10T00:00:00Z',
    conversationId: '100',
    media: [],
    links: [],
    tags: [],
    ingestedVia: 'graphql',
    ...recordOverrides,
  };

  await writeFile(path.join(dir, 'bookmarks.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  await buildIndex({ force: true });
  return dir;
}

function installFetchMock(handler: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function createRuntime(): Promise<ProcessorRuntime> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  ensureLinkContentSchema(db);
  const mediaDir = bookmarkMediaDir();
  await ensureDir(mediaDir);
  return {
    db,
    dbPath,
    csrfToken: 'csrf-token',
    cookieHeader: 'ct0=csrf-token',
    tweetDetailQueryId: 'TweetDetail',
    bookmarksQueryId: 'Bookmarks',
    folderQueryId: 'BookmarkFolderTimeline',
    githubToken: undefined,
    mediaDir,
    claimOwner: 'test-owner',
    delayMs: 0,
    maxBytes: 1024 * 1024,
  };
}

test('processBookmark completes when thread, media, and links all succeed', { concurrency: false }, async (t) => {
  await setupBookmarkFixture();

  const restoreFetch = installFetchMock(async (url, init) => {
    if (url.includes('/TweetDetail?')) {
      return new Response(
        JSON.stringify(
          makeTweetDetailResponse(
            makeTweetResult('100', 'root tweet with full text', { links: ['https://example.com/article'] }),
            makeTweetResult('101', 'reply with media', {
              conversationId: '100',
              inReplyToStatusId: '100',
              mediaUrl: 'https://pbs.twimg.com/media/reply.jpg',
            }),
          ),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://pbs.twimg.com/media/reply.jpg' && init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '4', 'content-type': 'image/jpeg' } });
    }
    if (url === 'https://pbs.twimg.com/media/reply.jpg') {
      return new Response(Buffer.from('img1'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url === 'https://example.com/article') {
      return new Response(
        `<html><title>Example</title><main>${'useful content '.repeat(20)}</main></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const runtime = await createRuntime();
  t.after(() => runtime.db.close());

  const result = await processBookmark('100', { runtime });
  assert.equal(result.processingState, 'complete');
  assert.equal(result.mediaDownloaded, 1);
  assert.equal(result.linksFetched, 1);
  assert.equal(result.threadTweetsStored, 2);

  const processing = await getBookmarkProcessing('100');
  assert.equal(processing?.processingState, 'complete');
  assert.equal(processing?.mediaStatus, 'complete');
  assert.equal(processing?.linksStatus, 'complete');

  const mediaRows = runtime.db.exec(`SELECT status, local_path FROM bookmark_media_targets WHERE bookmark_id = '100'`);
  assert.equal(mediaRows[0]?.values?.[0]?.[0], 'downloaded');
  assert.ok(fs.existsSync(String(mediaRows[0]?.values?.[0]?.[1])));

  const linkRows = runtime.db.exec(`SELECT status FROM bookmark_link_targets WHERE bookmark_id = '100'`);
  assert.equal(linkRows[0]?.values?.[0]?.[0], 'fetched');
});

test('processBookmark retries after a transient media failure and completes on the next run', { concurrency: false }, async (t) => {
  await setupBookmarkFixture();

  let shouldFailMedia = true;
  const restoreFetch = installFetchMock(async (url, init) => {
    if (url.includes('/TweetDetail?')) {
      return new Response(
        JSON.stringify(
          makeTweetDetailResponse(
            makeTweetResult('100', 'root tweet'),
            makeTweetResult('101', 'reply with media', {
              conversationId: '100',
              inReplyToStatusId: '100',
              mediaUrl: 'https://pbs.twimg.com/media/retry.jpg',
            }),
          ),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://pbs.twimg.com/media/retry.jpg' && init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '4', 'content-type': 'image/jpeg' } });
    }
    if (url === 'https://pbs.twimg.com/media/retry.jpg') {
      if (shouldFailMedia) throw new Error('socket hang up');
      return new Response(Buffer.from('img2'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const runtime = await createRuntime();
  t.after(() => runtime.db.close());

  const first = await processBookmark('100', { runtime });
  assert.equal(first.processingState, 'retryable_failed');
  assert.equal(first.mediaPending, 1);

  shouldFailMedia = false;
  const second = await processBookmark('100', { runtime });
  assert.equal(second.processingState, 'complete');

  const processing = await getBookmarkProcessing('100');
  assert.equal(processing?.processingState, 'complete');
  assert.ok((processing?.attemptCount ?? 0) >= 2);

  const failures = await listFailureEvents({ bookmarkId: '100', limit: 10 });
  assert.ok(failures.some((event) =>
    event.step === 'media' &&
    event.failureCode === 'download_failed' &&
    event.retryable === true &&
    event.targetRef === 'https://pbs.twimg.com/media/retry.jpg'
  ));
});

test('processBookmark leaves a bookmark terminally incomplete on a 404 TweetDetail', { concurrency: false }, async (t) => {
  await setupBookmarkFixture();

  const restoreFetch = installFetchMock(async (url) => {
    if (url.includes('/TweetDetail?')) {
      return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const runtime = await createRuntime();
  t.after(() => runtime.db.close());

  const result = await processBookmark('100', { runtime });
  assert.equal(result.processingState, 'terminal_incomplete');

  const processing = await getBookmarkProcessing('100');
  assert.equal(processing?.processingState, 'terminal_incomplete');
  assert.equal(processing?.coreStatus, 'incomplete');

  const failures = await listFailureEvents({ bookmarkId: '100', limit: 10 });
  assert.ok(failures.some((event) =>
    event.step === 'core' &&
    event.failureCode === 'http_404' &&
    event.retryable === false
  ));
});

test('processBookmark(force) re-runs an already complete bookmark through the direct pipeline', { concurrency: false }, async (t) => {
  await setupBookmarkFixture();

  const restoreFetch = installFetchMock(async (url, init) => {
    if (url.includes('/TweetDetail?')) {
      return new Response(
        JSON.stringify(
          makeTweetDetailResponse(
            makeTweetResult('100', 'root tweet with full text', { links: ['https://example.com/article'] }),
            makeTweetResult('101', 'reply with media', {
              conversationId: '100',
              inReplyToStatusId: '100',
              mediaUrl: 'https://pbs.twimg.com/media/replay.jpg',
            }),
          ),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://pbs.twimg.com/media/replay.jpg' && init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '4', 'content-type': 'image/jpeg' } });
    }
    if (url === 'https://pbs.twimg.com/media/replay.jpg') {
      return new Response(Buffer.from('img3'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url === 'https://example.com/article') {
      return new Response(
        `<html><title>Example</title><main>${'useful content '.repeat(20)}</main></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const runtime = await createRuntime();
  t.after(() => runtime.db.close());

  const first = await processBookmark('100', { runtime });
  assert.equal(first.processingState, 'complete');

  const skipped = await processBookmark('100', { runtime });
  assert.equal(skipped.skipped, true);

  const forced = await processBookmark('100', { runtime, force: true });
  assert.equal(forced.skipped, false);
  assert.equal(forced.processingState, 'complete');

  const processing = await getBookmarkProcessing('100');
  assert.ok((processing?.attemptCount ?? 0) >= 2);
});

test('syncBookmarksSequentially reuses one runtime and advances from resuming to fetching', { concurrency: false }, async (t) => {
  await setupBookmarkFixture();

  const runtime = await createRuntime();
  t.after(() => {
    try {
      runtime.db.close();
    } catch {}
  });

  runtime.db.run(
    `INSERT INTO sync_state(key, value, updated_at)
     VALUES ('legacy_migration_v1', 'done', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [new Date().toISOString()],
  );
  runtime.db.run(
    `UPDATE bookmark_processing
     SET processing_state = 'complete',
         core_status = 'complete',
         thread_status = 'complete',
         media_status = 'complete',
         links_status = 'complete',
         requires_revalidation = 0,
         updated_at = ?
     WHERE bookmark_id = '100'`,
    [new Date().toISOString()],
  );

  let runtimeFactoryCalls = 0;
  const stages: Array<SyncEngineProgress['stage']> = [];
  const details: string[] = [];

  const result = await syncBookmarksSequentially({
    incremental: true,
    maxPages: 1,
    delayMs: 0,
    maxMinutes: 1,
    folderId: 'folder-1',
    runtimeFactory: async () => {
      runtimeFactoryCalls += 1;
      return runtime;
    },
    pageFetcher: async () => ({ records: [], nextCursor: undefined }),
    onProgress: (status) => {
      stages.push(status.stage);
      if (status.detail) details.push(status.detail);
    },
  });

  assert.equal(runtimeFactoryCalls, 1);
  assert.equal(result.stopReason, 'end of bookmarks');
  assert.ok(stages.includes('preparing'));
  assert.ok(stages.includes('resuming'));
  assert.ok(stages.includes('fetching'));
  assert.equal(stages.at(-1), 'completed');
  assert.ok(details.includes('resuming incomplete backlog'));
  assert.ok(details.includes('fetching new folder posts'));
});
