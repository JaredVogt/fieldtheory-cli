import {
  GRAPHQL_FEATURES,
  GraphQLApiError,
  buildHeaders,
  fetchWithRetry,
  convertTweetToRecord,
  extractQuotedRecord,
} from './graphql-bookmarks.js';
import type { BookmarkRecord, ThreadTweetRecord } from './types.js';

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
  let filteredOutByConversation = 0;

  for (const tweetResult of tweetResults) {
    const record = convertTweetToRecord(tweetResult, now);
    if (!record) continue;
    if (seen.has(record.tweetId)) continue;

    // Filter to only tweets in the target conversation
    if (record.conversationId && record.conversationId !== targetConversationId) {
      filteredOutByConversation++;
      continue;
    }

    seen.add(record.tweetId);
    const snowflake = parseTweetSnowflake(record.tweetId);
    if (snowflake !== null) {
      records.push({ record, snowflake });
    }
  }

  // Twitter occasionally serves the focal tweet with a different conversation
  // id than the one we asked for (moved threads, retweet shapes). If the raw
  // response was non-empty but our filter dropped everything, we'd otherwise
  // return [] and deriveConversationTweets would synthesize a single focal
  // tweet — silently collapsing a real thread to one row marked "complete."
  // Raise it as a retryable error so the caller reclassifies and tries again.
  if (records.length === 0 && filteredOutByConversation > 0) {
    throw new GraphQLApiError({
      code: 'thread_conversation_mismatch',
      message: `TweetDetail returned ${filteredOutByConversation} tweets but none matched conversation ${targetConversationId}`,
      retryable: true,
    });
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
    mediaObjects: record.mediaObjects,
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
): Promise<{
  focalTweet: BookmarkRecord | null;
  quotedTweet: BookmarkRecord | null;
  threadTweets: ThreadTweetRecord[];
}> {
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
  const focalResult = tweetResults.find((tr: any) => {
    const t = tr?.tweet ?? tr;
    const id = t?.legacy?.id_str ?? t?.rest_id;
    return id === tweetId;
  }) ?? null;
  const focalTweet = focalResult ? convertTweetToRecord(focalResult, now) : null;
  const quotedTweet = focalResult ? extractQuotedRecord(focalResult, now) : null;

  return { focalTweet, quotedTweet, threadTweets };
}
