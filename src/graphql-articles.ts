import { buildHeaders, fetchWithRetry, GraphQLApiError } from './graphql-bookmarks.js';
import { getQueryId } from './graphql-query-ids.js';

// Feature flags required by TweetResultByRestId (extracted from main.1508522a.js).
// The key flag for getting article bodies is
// `responsive_web_twitter_article_tweet_consumption_enabled`.
const TWEET_RESULT_FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  rweb_cashtags_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

const TWEET_RESULT_FIELD_TOGGLES = {
  withPayments: false,
  withAuxiliaryUserLabels: false,
  withArticleRichContentState: true,
  withArticlePlainText: true,
  withArticleSummaryText: true,
  withArticleVoiceOver: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
};

export interface ArticleContent {
  restId: string;
  title: string;
  plainText: string;
  summary?: string;
  coverUrl?: string;
  publishedAt?: string;
}

function buildTweetResultUrl(queryId: string, tweetId: string): string {
  const variables = {
    tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
  };
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(TWEET_RESULT_FEATURES),
    fieldToggles: JSON.stringify(TWEET_RESULT_FIELD_TOGGLES),
  });
  return `https://x.com/i/api/graphql/${queryId}/TweetResultByRestId?${params}`;
}

/**
 * Reconstruct the full article body from DraftJS `content_state`.
 *
 * X's `plain_text` field only concatenates `unstyled` prose blocks and drops
 * `atomic` blocks, which is where code snippets, embedded tweets, and images
 * live. Those atomic blocks are where most of an article's substance often
 * sits. Walking `blocks` + `entityMap` ourselves preserves them.
 */
function reconstructArticleText(contentState: any): string {
  if (!contentState || !Array.isArray(contentState.blocks)) return '';
  const entityList: Array<{ key: string; value: any }> = Array.isArray(contentState.entityMap)
    ? contentState.entityMap
    : [];
  const entityByKey = new Map<string, any>();
  for (const entry of entityList) entityByKey.set(String(entry.key), entry.value);

  const parts: string[] = [];
  for (const block of contentState.blocks) {
    const type: string = block.type ?? 'unstyled';
    const text: string = block.text ?? '';

    if (type === 'atomic' && Array.isArray(block.entityRanges) && block.entityRanges.length > 0) {
      const entity = entityByKey.get(String(block.entityRanges[0].key));
      if (entity?.type === 'MARKDOWN' && entity.data?.markdown) {
        parts.push(entity.data.markdown);
      } else if (entity?.type === 'IMAGE' && entity.data?.url) {
        parts.push(`![](${entity.data.url})`);
      } else if (entity?.type === 'TWEET' && entity.data?.url) {
        parts.push(`[Embedded tweet](${entity.data.url})`);
      } else if (entity?.data?.url) {
        parts.push(`[${entity.type ?? 'Embed'}](${entity.data.url})`);
      }
      continue;
    }

    switch (type) {
      case 'header-one':   parts.push(`# ${text}`); break;
      case 'header-two':   parts.push(`## ${text}`); break;
      case 'header-three': parts.push(`### ${text}`); break;
      case 'header-four':  parts.push(`#### ${text}`); break;
      case 'unordered-list-item': parts.push(`- ${text}`); break;
      case 'ordered-list-item':   parts.push(`1. ${text}`); break;
      case 'blockquote':   parts.push(`> ${text}`); break;
      case 'code-block':   parts.push('```\n' + text + '\n```'); break;
      default:             parts.push(text); break; // 'unstyled' + unknown
    }
  }
  return parts.join('\n\n').trim();
}

function extractArticle(tweetResult: any): ArticleContent | null {
  const tweet = tweetResult?.tweet ?? tweetResult;
  const articleNode = tweet?.article?.article_results?.result;
  if (!articleNode) return null;

  const restId: string | undefined = articleNode.rest_id ?? articleNode.id;
  const title: string = articleNode.title ?? '';
  const reconstructed = reconstructArticleText(articleNode.content_state);
  const plainText: string = reconstructed || articleNode.plain_text || '';
  if (!restId || !plainText) return null;

  const summary: string | undefined = articleNode.summary_text || undefined;

  const coverInfo = articleNode.cover_media?.media_info;
  const coverUrl: string | undefined =
    coverInfo?.original_img_url ||
    coverInfo?.expandable_url ||
    coverInfo?.url ||
    undefined;

  const publishedSecs: number | undefined =
    articleNode.metadata?.first_published_at_secs;
  const publishedAt = publishedSecs
    ? new Date(publishedSecs * 1000).toISOString()
    : undefined;

  return { restId, title, plainText, summary, coverUrl, publishedAt };
}

/**
 * Fetch an article attached to a tweet via TweetResultByRestId.
 *
 * Returns the parsed article, or null if the tweet has no article attached.
 * Throws a GraphQLApiError for transport/auth/rate issues so callers can
 * classify them as retryable.
 */
export async function fetchTweetArticle(
  tweetId: string,
  csrfToken: string,
  cookieHeader?: string,
): Promise<ArticleContent | null> {
  const queryId = await getQueryId('TweetResultByRestId');
  const url = buildTweetResultUrl(queryId, tweetId);
  const json = await fetchWithRetry(
    url,
    buildHeaders(csrfToken, cookieHeader),
    'TweetResultByRestId',
  );

  const tr = json?.data?.tweetResult?.result;
  if (!tr) {
    // Some tombstones or auth-protected tweets come back with data but no result.
    throw new GraphQLApiError({
      code: 'article_empty_response',
      message: 'TweetResultByRestId returned no tweetResult',
      retryable: false,
    });
  }
  return extractArticle(tr);
}

export const ARTICLE_URL_REGEX = /^https?:\/\/(?:x\.com|twitter\.com)\/(i|[^/]+)\/article\/(\d+)/i;

/**
 * Does this URL point to an X native article?
 * Matches both /i/article/{id} and /{handle}/article/{id}.
 */
export function isXArticleUrl(url: string): boolean {
  return ARTICLE_URL_REGEX.test(url);
}
