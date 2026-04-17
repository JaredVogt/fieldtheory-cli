import { ensureDir, readJsonLines, writeJsonLines, readJson, writeJson, pathExists } from './fs.js';
import { ensureDataDir, twitterBookmarksCachePath, twitterBackfillStatePath } from './paths.js';
import { loadChromeSessionConfig } from './config.js';
import { extractChromeXCookies } from './chrome-cookies.js';
import type { BookmarkBackfillState, BookmarkFolder, BookmarkRecord } from './types.js';
import { exportBookmarksForSyncSeed } from './bookmarks-db.js';
import { getQueryId } from './graphql-query-ids.js';

export const X_PUBLIC_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const BOOKMARKS_OPERATION = 'Bookmarks';

export const GRAPHQL_FEATURES = {
  graphql_timeline_v2_bookmark_timeline: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_uc_gql_enabled: true,
  vibe_api_enabled: true,
  responsive_web_text_conversations_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_media_download_video_enabled: false,
  longform_notetweets_consumption_enabled: true,
};

export interface SyncOptions {
  /** Default true. Stop once we reach the newest already-stored bookmark. */
  incremental?: boolean;
  /** Max pages to fetch (20 bookmarks per page). Default: 500 */
  maxPages?: number;
  /** Stop once this many *new* bookmarks have been added. Default: unlimited */
  targetAdds?: number;
  /** Delay between page requests in ms. Default: 600 */
  delayMs?: number;
  /** Max runtime in minutes. Default: 30 */
  maxMinutes?: number;
  /** Consecutive pages with 0 new bookmarks before stopping. Default: 3 */
  stalePageLimit?: number;
  /** Chrome user-data-dir override. */
  chromeUserDataDir?: string;
  /** Chrome profile directory name (e.g. "Default"). */
  chromeProfileDirectory?: string;
  /** Direct csrf token override; skips Chrome cookie extraction. */
  csrfToken?: string;
  /** Direct cookie header override; skips Chrome cookie extraction. */
  cookieHeader?: string;
  /** Progress callback. */
  onProgress?: (status: SyncProgress) => void;
  /** Flush to disk every N pages. Default: 25 */
  checkpointEvery?: number;
  /** Sync a specific bookmark folder instead of all bookmarks. */
  folderId?: string;
}

export interface SyncProgress {
  page: number;
  totalFetched: number;
  newAdded: number;
  running: boolean;
  done: boolean;
  stopReason?: string;
}

export interface SyncResult {
  added: number;
  totalBookmarks: number;
  pages: number;
  stopReason: string;
  cachePath: string;
  statePath: string;
}

function parseSnowflake(value?: string | null): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseBookmarkTimestamp(record: BookmarkRecord): number | null {
  const candidates = [record.bookmarkedAt, record.postedAt, record.syncedAt];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function compareBookmarkChronology(a: BookmarkRecord, b: BookmarkRecord): number {
  const aTimestamp = parseBookmarkTimestamp(a);
  const bTimestamp = parseBookmarkTimestamp(b);
  if (aTimestamp != null && bTimestamp != null && aTimestamp !== bTimestamp) {
    return aTimestamp > bTimestamp ? 1 : -1;
  }

  const aId = parseSnowflake(a.tweetId ?? a.id);
  const bId = parseSnowflake(b.tweetId ?? b.id);
  if (aId != null && bId != null && aId !== bId) {
    return aId > bId ? 1 : -1;
  }

  const aStamp = String(a.bookmarkedAt ?? a.postedAt ?? a.syncedAt ?? '');
  const bStamp = String(b.bookmarkedAt ?? b.postedAt ?? b.syncedAt ?? '');
  return aStamp.localeCompare(bStamp);
}

async function loadExistingBookmarks(): Promise<BookmarkRecord[]> {
  const cachePath = twitterBookmarksCachePath();
  const existing = await readJsonLines<BookmarkRecord>(cachePath);
  if (existing.length > 0) return existing;
  try {
    return await exportBookmarksForSyncSeed();
  } catch (err) {
    // On genuine first run, no index exists — that's fine, empty seed. For
    // other failures (DB corrupt, FS issue) we want the user to know why
    // incremental sync just became a full re-sync.
    const message = (err as Error).message ?? String(err);
    if (!/no such table|does not exist|ENOENT|not found/i.test(message)) {
      process.stderr.write(`  Warning: could not seed sync from existing index (${message.slice(0, 200)}). Falling back to full sync.\n`);
    }
    return [];
  }
}

function buildUrl(queryId: string, cursor?: string): string {
  const variables: Record<string, unknown> = { count: 20 };
  if (cursor) variables.cursor = cursor;
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(GRAPHQL_FEATURES),
  });
  return `https://x.com/i/api/graphql/${queryId}/${BOOKMARKS_OPERATION}?${params}`;
}

export function buildHeaders(csrfToken: string, cookieHeader?: string): Record<string, string> {
  return {
    authorization: `Bearer ${X_PUBLIC_BEARER}`,
    'x-csrf-token': csrfToken,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    cookie: cookieHeader ?? `ct0=${csrfToken}`,
  };
}

export interface PageResult {
  records: BookmarkRecord[];
  nextCursor?: string;
}

export function convertTweetToRecord(tweetResult: any, now: string): BookmarkRecord | null {
  const tweet = tweetResult.tweet ?? tweetResult;
  const legacy = tweet?.legacy;
  if (!legacy) return null;

  const tweetId = legacy.id_str ?? tweet?.rest_id;
  if (!tweetId) return null;

  const userResult = tweet?.core?.user_results?.result;
  const authorHandle = userResult?.core?.screen_name ?? userResult?.legacy?.screen_name;
  const authorName = userResult?.core?.name ?? userResult?.legacy?.name;
  const authorProfileImageUrl =
    userResult?.avatar?.image_url ??
    userResult?.legacy?.profile_image_url_https ??
    userResult?.legacy?.profile_image_url;

  const author = userResult
    ? {
        id: userResult.rest_id,
        handle: authorHandle,
        name: authorName,
        profileImageUrl: authorProfileImageUrl,
        bio: userResult?.legacy?.description,
        followerCount: userResult?.legacy?.followers_count,
        followingCount: userResult?.legacy?.friends_count,
        isVerified: Boolean(userResult?.is_blue_verified ?? userResult?.legacy?.verified),
        location:
          typeof userResult?.location === 'object'
            ? userResult.location.location
            : userResult?.legacy?.location,
        snapshotAt: now,
      }
    : undefined;

  const mediaEntities = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
  const media: string[] = mediaEntities
    .map((m: any) => m.media_url_https ?? m.media_url)
    .filter(Boolean);
  const mediaObjects = mediaEntities.map((m: any) => ({
    type: m.type,
    url: m.media_url_https ?? m.media_url,
    expandedUrl: m.expanded_url,
    width: m.original_info?.width,
    height: m.original_info?.height,
    altText: m.ext_alt_text,
    videoVariants: Array.isArray(m.video_info?.variants)
      ? m.video_info.variants
          .filter((v: any) => v.content_type === 'video/mp4')
          .map((v: any) => ({ bitrate: v.bitrate, url: v.url }))
      : undefined,
  }));

  const noteTweetEntities = tweet?.note_tweet?.note_tweet_results?.result?.entity_set;
  const urlEntities = [
    ...(legacy?.entities?.urls ?? []),
    ...(noteTweetEntities?.urls ?? []),
  ];
  const links: string[] = [...new Set(
    urlEntities
      .map((u: any) => u.expanded_url)
      .filter((u: string | undefined) => u && !u.includes('t.co'))
  )];

  return {
    id: tweetId,
    tweetId,
    url: `https://x.com/${authorHandle ?? '_'}/status/${tweetId}`,
    text: tweet?.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text ?? legacy.text ?? '',
    authorHandle,
    authorName,
    authorProfileImageUrl,
    author,
    postedAt: legacy.created_at ?? null,
    bookmarkedAt: null,
    syncedAt: now,
    conversationId: legacy.conversation_id_str,
    inReplyToStatusId: legacy.in_reply_to_status_id_str,
    inReplyToUserId: legacy.in_reply_to_user_id_str,
    quotedStatusId: legacy.quoted_status_id_str,
    language: legacy.lang,
    sourceApp: legacy.source,
    possiblySensitive: legacy.possibly_sensitive,
    engagement: {
      likeCount: legacy.favorite_count,
      repostCount: legacy.retweet_count,
      replyCount: legacy.reply_count,
      quoteCount: legacy.quote_count,
      bookmarkCount: legacy.bookmark_count,
      viewCount: tweet?.views?.count ? Number(tweet.views.count) : undefined,
    },
    media,
    mediaObjects,
    links,
    tags: [],
    ingestedVia: 'graphql',
  };
}

export function extractQuotedRecord(tweetResult: any, now: string): BookmarkRecord | null {
  const tweet = tweetResult?.tweet ?? tweetResult;
  const quotedResult = tweet?.quoted_status_result?.result;
  if (!quotedResult) return null;
  const quoted = convertTweetToRecord(quotedResult, now);
  if (quoted) quoted.ingestedVia = 'quoted';
  return quoted;
}

export function parseTimelineEntries(instructions: any[], now: string): PageResult {
  const entries: any[] = [];
  for (const inst of instructions) {
    if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
      entries.push(...inst.entries);
    }
  }

  const records: BookmarkRecord[] = [];
  let nextCursor: string | undefined;

  for (const entry of entries) {
    if (entry.entryId?.startsWith('cursor-bottom')) {
      nextCursor = entry.content?.value;
      continue;
    }

    const tweetResult = entry?.content?.itemContent?.tweet_results?.result;
    if (!tweetResult) continue;

    const record = convertTweetToRecord(tweetResult, now);
    if (record) records.push(record);
    const quoted = extractQuotedRecord(tweetResult, now);
    if (quoted) records.push(quoted);
  }

  return { records, nextCursor };
}

export function parseBookmarksResponse(json: any, now?: string): PageResult {
  const ts = now ?? new Date().toISOString();
  const instructions = json?.data?.bookmark_timeline_v2?.timeline?.instructions ?? [];
  return parseTimelineEntries(instructions, ts);
}

export class GraphQLApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly twitterCode?: number;
  readonly resetAt?: Date;

  constructor(params: {
    code: string;
    message: string;
    retryable: boolean;
    status?: number;
    twitterCode?: number;
    resetAt?: Date;
  }) {
    super(params.message);
    this.name = 'GraphQLApiError';
    this.code = params.code;
    this.retryable = params.retryable;
    this.status = params.status;
    this.twitterCode = params.twitterCode;
    this.resetAt = params.resetAt;
  }
}

function parseResetAt(response: Response): Date | undefined {
  const resetHeader = response.headers.get('x-rate-limit-reset') ?? response.headers.get('retry-after');
  if (!resetHeader) return undefined;
  const num = Number(resetHeader);
  if (!Number.isFinite(num)) {
    const parsed = Date.parse(resetHeader);
    return Number.isFinite(parsed) ? new Date(parsed) : undefined;
  }
  // retry-after may be seconds-from-now; x-rate-limit-reset is epoch seconds.
  // Heuristic: anything < ~10 years of epoch seconds is a seconds-from-now delta.
  if (num < 1_000_000) return new Date(Date.now() + num * 1000);
  return new Date(num * 1000);
}

// Twitter/X returns HTTP 200 with a body-level `errors` array for many failure
// modes (stale auth, soft rate limits, deleted/protected tweets). Classify
// known codes so callers can decide retry vs terminal.
// Refs: https://developer.x.com/en/docs/x-api/v1/troubleshooting/error-codes
function classifyTwitterErrorCode(code: number): { code: string; retryable: boolean } {
  switch (code) {
    case 32: // Could not authenticate you
    case 64: // Account suspended
    case 88: // Rate limit exceeded
    case 89: // Invalid or expired token
    case 215: // Bad authentication data
    case 220: // Your credentials do not allow
    case 326: // User is temporarily locked out
      return { code: 'auth_or_rate_limited', retryable: true };
    case 34: // No data / not found
    case 63: // User suspended
    case 144: // No status found with that ID
    case 179: // Sorry, you are not authorized to see this status
    case 421: // Tweet no longer available
    case 422: // Tweet no longer available, violation
      return { code: 'not_found_or_protected', retryable: false };
    case 131: // Internal error
    case 130: // Over capacity
      return { code: 'server_error', retryable: true };
    default:
      // Unknown code: default retryable so we don't permanently mark bookmarks
      // terminal on a code we haven't mapped.
      return { code: 'twitter_error', retryable: true };
  }
}

function inspectBodyErrors(json: any, label: string, status: number): void {
  if (!json || typeof json !== 'object') return;
  const errors = (json as any).errors;
  if (!Array.isArray(errors) || errors.length === 0) return;
  const first = errors[0] ?? {};
  const twitterCode = typeof first.code === 'number' ? first.code : undefined;
  const msg = typeof first.message === 'string' ? first.message : JSON.stringify(first);
  const classified = twitterCode != null
    ? classifyTwitterErrorCode(twitterCode)
    : { code: 'twitter_error', retryable: true };
  throw new GraphQLApiError({
    code: classified.code,
    retryable: classified.retryable,
    message: `${label}: body-level error (code ${twitterCode ?? '?'}): ${msg}`,
    status,
    twitterCode,
  });
}

export async function fetchWithRetry(url: string, headers: Record<string, string>, label = 'GraphQL API'): Promise<any> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      const resetAt = parseResetAt(response);
      const nowMs = Date.now();
      // Honor server-provided reset window when present; clamp to 10 min so a
      // bogus header can't strand the process.
      const serverWaitMs = resetAt ? Math.max(0, resetAt.getTime() - nowMs) : undefined;
      const fallbackWaitMs = Math.min(15 * Math.pow(2, attempt), 120) * 1000;
      const waitMs = Math.min(serverWaitMs ?? fallbackWaitMs, 600_000);
      const resetSuffix = resetAt ? ` (resets at ${resetAt.toISOString()})` : '';
      lastError = new GraphQLApiError({
        code: 'rate_limited',
        message: `${label}: rate limited (429) on attempt ${attempt + 1}${resetSuffix}`,
        retryable: true,
        status: 429,
        resetAt,
      });
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (response.status >= 500) {
      const bodySnippet = (await response.text().catch(() => '')).slice(0, 300);
      lastError = new GraphQLApiError({
        code: 'server_error',
        message: `${label}: server error (${response.status}) on attempt ${attempt + 1}${bodySnippet ? `: ${bodySnippet}` : ''}`,
        retryable: true,
        status: response.status,
      });
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const isAuth = response.status === 401 || response.status === 403;
      throw new GraphQLApiError({
        code: response.status === 404 ? 'http_404'
          : response.status === 403 ? 'http_403'
          : response.status === 401 ? 'http_401'
          : `http_${response.status}`,
        retryable: false,
        status: response.status,
        message:
          `${label} returned ${response.status}.\n` +
          `Response: ${text.slice(0, 300)}\n\n` +
          (isAuth
            ? 'Fix: Your X session may have expired. Open Chrome, go to https://x.com, and make sure you are logged in. Then retry.'
            : 'This may be a temporary issue. Try again in a few minutes.'),
      });
    }

    const json = await response.json();
    inspectBodyErrors(json, label, response.status);
    return json;
  }

  throw lastError ?? new GraphQLApiError({
    code: 'transient_error',
    message: `${label}: all retry attempts failed. Try again later.`,
    retryable: true,
  });
}

export async function fetchBookmarkTimelinePage(args: {
  csrfToken: string;
  queryId: string;
  cursor?: string;
  cookieHeader?: string;
  folderId?: string;
  folderQueryId?: string;
}): Promise<PageResult> {
  const { csrfToken, queryId, cursor, cookieHeader, folderId, folderQueryId } = args;
  const url = folderId
    ? buildFolderTimelineUrl(folderQueryId!, folderId, cursor)
    : buildUrl(queryId, cursor);
  const label = folderId ? 'BookmarkFolderTimeline' : 'GraphQL Bookmarks API';
  const json = await fetchWithRetry(url, buildHeaders(csrfToken, cookieHeader), label);
  return folderId ? parseFolderTimelineResponse(json) : parseBookmarksResponse(json);
}

export function scoreRecord(record: BookmarkRecord): number {
  let score = 0;
  if (record.postedAt) score += 2;
  if (record.authorProfileImageUrl) score += 2;
  if (record.author) score += 3;
  if (record.engagement) score += 3;
  if ((record.mediaObjects?.length ?? 0) > 0) score += 3;
  if ((record.links?.length ?? 0) > 0) score += 2;
  return score;
}

export function mergeBookmarkRecord(existing: BookmarkRecord | undefined, incoming: BookmarkRecord): BookmarkRecord {
  if (!existing) return incoming;
  return scoreRecord(incoming) >= scoreRecord(existing)
    ? { ...existing, ...incoming }
    : { ...incoming, ...existing };
}

export function mergeRecords(
  existing: BookmarkRecord[],
  incoming: BookmarkRecord[]
): { merged: BookmarkRecord[]; added: number } {
  const byId = new Map(existing.map((r) => [r.id, r]));
  let added = 0;
  for (const record of incoming) {
    const prev = byId.get(record.id);
    if (!prev) added += 1;
    byId.set(record.id, mergeBookmarkRecord(prev, record));
  }
  const merged = Array.from(byId.values());
  merged.sort((a, b) => compareBookmarkChronology(b, a));
  return { merged, added };
}

function updateState(
  prev: BookmarkBackfillState,
  input: { added: number; seenIds: string[]; stopReason: string }
): BookmarkBackfillState {
  return {
    provider: 'twitter',
    lastRunAt: new Date().toISOString(),
    totalRuns: prev.totalRuns + 1,
    totalAdded: prev.totalAdded + input.added,
    lastAdded: input.added,
    lastSeenIds: input.seenIds.slice(-20),
    stopReason: input.stopReason,
  };
}

export function formatSyncResult(result: SyncResult): string {
  return [
    'Sync complete.',
    `- bookmarks added: ${result.added}`,
    `- total bookmarks: ${result.totalBookmarks}`,
    `- pages fetched: ${result.pages}`,
    `- stop reason: ${result.stopReason}`,
    `- cache: ${result.cachePath}`,
    `- state: ${result.statePath}`,
  ].join('\n');
}

// ── Folder endpoints ──────────────────────────────────────────────────────

const FOLDERS_OPERATION = 'BookmarkFoldersSlice';
const FOLDER_TIMELINE_OPERATION = 'BookmarkFolderTimeline';

function buildFoldersUrl(queryId: string): string {
  const params = new URLSearchParams({
    variables: JSON.stringify({}),
    features: JSON.stringify(GRAPHQL_FEATURES),
  });
  return `https://x.com/i/api/graphql/${queryId}/${FOLDERS_OPERATION}?${params}`;
}

function buildFolderTimelineUrl(queryId: string, folderId: string, cursor?: string): string {
  const variables: Record<string, unknown> = {
    bookmark_collection_id: folderId,
    count: 20,
  };
  if (cursor) variables.cursor = cursor;
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(GRAPHQL_FEATURES),
  });
  return `https://x.com/i/api/graphql/${queryId}/${FOLDER_TIMELINE_OPERATION}?${params}`;
}

export function parseFoldersResponse(json: any): BookmarkFolder[] {
  const data = json?.data;
  const collections =
    // New path: BookmarkFoldersSlice (2025+)
    data?.viewer?.user_results?.result?.bookmark_collections_slice?.items ??
    // Legacy path: BookmarksAllFolders
    data?.bookmark_collections?.collections ??
    [];

  return collections.map((c: any) => ({
    id: String(c.id),
    name: String(c.name ?? ''),
    bookmarkCount: typeof c.bookmark_count === 'number' ? c.bookmark_count : undefined,
  }));
}

export function parseFolderTimelineResponse(json: any, now?: string): PageResult {
  const ts = now ?? new Date().toISOString();
  const instructions = json?.data?.bookmark_collection_timeline?.timeline?.instructions ?? [];
  return parseTimelineEntries(instructions, ts);
}

export async function listBookmarkFolders(
  csrfToken: string,
  cookieHeader?: string,
): Promise<BookmarkFolder[]> {
  const queryId = await getQueryId('BookmarkFoldersSlice');
  const json = await fetchWithRetry(
    buildFoldersUrl(queryId),
    buildHeaders(csrfToken, cookieHeader),
    'BookmarkFoldersSlice',
  );
  return parseFoldersResponse(json);
}

export async function resolveFolder(
  input: string | true | undefined,
  csrfToken: string,
  cookieHeader?: string,
): Promise<{ id: string; name: string } | 'picker'> {
  if (input === undefined || input === true) return 'picker';

  const str = String(input).trim();

  // URL → extract numeric ID
  const urlMatch = str.match(/bookmarks\/(\d+)/);
  if (urlMatch) return { id: urlMatch[1], name: urlMatch[1] };

  // Bare numeric ID
  if (/^\d+$/.test(str)) return { id: str, name: str };

  // Name → fetch list and match
  const folders = await listBookmarkFolders(csrfToken, cookieHeader);

  const exact = folders.find((f) => f.name.toLowerCase() === str.toLowerCase());
  if (exact) return { id: exact.id, name: exact.name };

  const partial = folders.filter((f) => f.name.toLowerCase().includes(str.toLowerCase()));
  if (partial.length === 1) return { id: partial[0].id, name: partial[0].name };

  if (partial.length > 1) {
    const list = partial.map((f) => `    ${f.name}`).join('\n');
    throw new Error(`Multiple folders match "${str}":\n${list}\n\n  Be more specific, or use: ft sync --folder`);
  }

  const list = folders.map((f) => `    ${f.name}`).join('\n');
  throw new Error(`No folder named "${str}" found.\n\n  Your folders:\n${list}\n\n  Use: ft sync --folder   (for interactive picker)`);
}

// ── Main sync ─────────────────────────────────────────────────────────────

export async function syncBookmarksGraphQL(
  options: SyncOptions = {}
): Promise<SyncResult> {
  const incremental = options.incremental ?? true;
  const maxPages = options.maxPages ?? 500;
  const delayMs = options.delayMs ?? 600;
  const maxMinutes = options.maxMinutes ?? 30;
  const stalePageLimit = options.stalePageLimit ?? 3;
  const checkpointEvery = options.checkpointEvery ?? 25;

  // Resolve GraphQL query IDs (auto-extracted from X's JS bundle)
  const bookmarksQueryId = options.folderId
    ? '' // not needed for folder sync
    : await getQueryId('Bookmarks');
  const folderQueryId = options.folderId
    ? await getQueryId('BookmarkFolderTimeline')
    : undefined;

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
  const cachePath = twitterBookmarksCachePath();
  const statePath = twitterBackfillStatePath();
  let existing = await loadExistingBookmarks();
  const newestKnownId = incremental
    ? existing.slice().sort((a, b) => compareBookmarkChronology(b, a))[0]?.id
    : undefined;
  const prevState: BookmarkBackfillState = (await pathExists(statePath))
    ? await readJson<BookmarkBackfillState>(statePath)
    : { provider: 'twitter', totalRuns: 0, totalAdded: 0, lastAdded: 0, lastSeenIds: [] };

  const started = Date.now();
  let page = 0;
  let totalAdded = 0;
  let stalePages = 0;
  let cursor: string | undefined;
  const allSeenIds: string[] = [];
  let stopReason = 'unknown';

  while (page < maxPages) {
    if (Date.now() - started > maxMinutes * 60_000) {
      stopReason = 'max runtime reached';
      break;
    }

    const result = await fetchBookmarkTimelinePage({
      csrfToken,
      queryId: bookmarksQueryId,
      cursor,
      cookieHeader,
      folderId: options.folderId,
      folderQueryId,
    });
    page += 1;

    if (result.records.length === 0 && !result.nextCursor) {
      stopReason = 'end of bookmarks';
      break;
    }

    const { merged, added } = mergeRecords(existing, result.records);
    existing = merged;
    totalAdded += added;
    result.records.forEach((r) => allSeenIds.push(r.id));
    const reachedLatestStored = Boolean(newestKnownId) && result.records.some((record) => record.id === newestKnownId);

    stalePages = added === 0 ? stalePages + 1 : 0;

    options.onProgress?.({
      page,
      totalFetched: allSeenIds.length,
      newAdded: totalAdded,
      running: true,
      done: false,
    });

    if (options.targetAdds && totalAdded >= options.targetAdds) {
      stopReason = 'target additions reached';
      break;
    }
    if (incremental && reachedLatestStored) {
      stopReason = 'caught up to newest stored bookmark';
      break;
    }
    if (incremental && stalePages >= stalePageLimit) {
      stopReason = 'no new bookmarks (stale)';
      break;
    }
    if (!result.nextCursor) {
      stopReason = 'end of bookmarks';
      break;
    }

    if (page % checkpointEvery === 0) await writeJsonLines(cachePath, existing);

    cursor = result.nextCursor;
    if (page < maxPages) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (stopReason === 'unknown') stopReason = page >= maxPages ? 'max pages reached' : 'unknown';

  await writeJsonLines(cachePath, existing);
  await writeJson(statePath, updateState(prevState, { added: totalAdded, seenIds: allSeenIds.slice(-20), stopReason }));

  options.onProgress?.({
    page,
    totalFetched: allSeenIds.length,
    newAdded: totalAdded,
    running: false,
    done: true,
    stopReason,
  });

  return { added: totalAdded, totalBookmarks: existing.length, pages: page, stopReason, cachePath, statePath };
}
