import { readJson, writeJson, pathExists } from './fs.js';
import { dataDir } from './paths.js';
import path from 'node:path';

export type OperationName =
  | 'Bookmarks'
  | 'BookmarkFoldersSlice'
  | 'BookmarkFolderTimeline'
  | 'TweetDetail'
  | 'TweetResultByRestId';

interface QueryIdCache {
  ids: Record<string, string>;
  fetchedAt: string;
}

const CACHE_FILE = 'graphql-query-ids.json';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function cachePath(): string {
  return path.join(dataDir(), CACHE_FILE);
}

let memoryCache: Record<string, string> | null = null;

async function loadCache(): Promise<Record<string, string> | null> {
  if (memoryCache) return memoryCache;
  const p = cachePath();
  if (!(await pathExists(p))) return null;
  try {
    const data = await readJson<QueryIdCache>(p);
    const age = Date.now() - new Date(data.fetchedAt).getTime();
    if (age > CACHE_MAX_AGE_MS) return null;
    memoryCache = data.ids;
    return data.ids;
  } catch {
    return null;
  }
}

async function saveCache(ids: Record<string, string>): Promise<void> {
  memoryCache = ids;
  await writeJson(cachePath(), { ids, fetchedAt: new Date().toISOString() } satisfies QueryIdCache);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

/** Extract queryId/operationName pairs from a JS source string. */
function extractQueryIds(js: string, ids: Record<string, string>): void {
  const pairRegex = /queryId:"([^"]+)",operationName:"([^"]+)"/g;
  let m;
  while ((m = pairRegex.exec(js)) !== null) {
    ids[m[2]] = m[1];
  }
}

/** Find matching close brace/paren for an opener at `openPos`. */
function findMatchingDelimiter(str: string, openPos: number): number {
  const open = str[openPos];
  const close = open === '{' ? '}' : open === '(' ? ')' : ']';
  let depth = 1;
  for (let i = openPos + 1; i < str.length; i++) {
    if (str[i] === open) depth++;
    else if (str[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parse a flat JS object literal body like `0:"abc",1:"def"` into a Record. */
function parseChunkMapLiteral(str: string): Record<string, string> {
  const result: Record<string, string> = {};
  const entryRegex = /(\d+):"([^"]+)"/g;
  let m;
  while ((m = entryRegex.exec(str)) !== null) {
    result[m[1]] = m[2];
  }
  return result;
}

/**
 * Discover lazy-loaded chunk URLs from X's HTML.
 *
 * X's inline webpack runtime has:
 *   g.p = "https://abs.twimg.com/responsive-web/client-web/"
 *   g.u = e => (({nameMap}[e] || e) + "." + {hashMap}[e] + "a.js")
 *
 * The chunk manifest (nameMap + hashMap) is inside g.u. We parse both maps
 * and the trailing suffix (e.g. "a.js") to construct full chunk URLs.
 */
function discoverLazyChunkUrls(html: string): string[] {
  // Extract the inline webpack runtime script (the large one with __SCRIPTS_LOADED__)
  let runtimeJs = '';
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    if (m[1].includes('__SCRIPTS_LOADED__') && m[1].length > 10000) {
      runtimeJs = m[1];
      break;
    }
  }
  if (!runtimeJs) return [];

  // Find public path: g.p="https://abs.twimg.com/responsive-web/client-web/"
  const publicPathMatch = runtimeJs.match(/\.p\s*=\s*"(https:\/\/[^"]*twimg[^"]*)"/);
  if (!publicPathMatch) return [];
  const publicPath = publicPathMatch[1];

  // Find the chunk URL function: g.u=e=>(...)
  // We need to find ".u=e=>" or ".u=function" and extract the full expression
  let uFuncBody = '';
  for (const anchor of ['.u=e=>', '.u=function']) {
    const idx = runtimeJs.indexOf(anchor);
    if (idx === -1) continue;

    // Find the opening paren of the outer expression
    const afterAnchor = anchor === '.u=e=>' ? idx + anchor.length : idx;
    const parenIdx = runtimeJs.indexOf('(', afterAnchor);
    if (parenIdx === -1 || parenIdx > afterAnchor + 50) continue;

    const closeIdx = findMatchingDelimiter(runtimeJs, parenIdx);
    if (closeIdx !== -1) {
      uFuncBody = runtimeJs.substring(parenIdx, closeIdx + 1);
      break;
    }
  }
  if (!uFuncBody) return [];

  // Extract the two large object literals (nameMap and hashMap)
  const maps: Record<string, string>[] = [];
  let pos = 0;
  while (pos < uFuncBody.length && maps.length < 3) {
    const braceIdx = uFuncBody.indexOf('{', pos);
    if (braceIdx === -1) break;

    const peek = uFuncBody.substring(braceIdx + 1, braceIdx + 15);
    if (/^\d+:"/.test(peek)) {
      const closeIdx = findMatchingDelimiter(uFuncBody, braceIdx);
      if (closeIdx !== -1) {
        const parsed = parseChunkMapLiteral(uFuncBody.substring(braceIdx + 1, closeIdx));
        if (Object.keys(parsed).length >= 5) {
          maps.push(parsed);
          pos = closeIdx + 1;
          continue;
        }
      }
    }
    pos = braceIdx + 1;
  }

  if (maps.length < 2) return [];

  const nameMap = maps[0];
  const hashMap = maps[1];

  // Extract the file suffix after the hashMap (e.g. "a.js" or ".js")
  // Pattern: ...}[e]+"SUFFIX")
  const suffixMatch = uFuncBody.match(/\}\[\w\]\+"([^"]+)"\s*\)/);
  const suffix = suffixMatch ? suffixMatch[1] : '.js';

  const urls: string[] = [];
  for (const key of Object.keys(nameMap)) {
    const hash = hashMap[key];
    if (hash) {
      urls.push(`${publicPath}${nameMap[key]}.${hash}${suffix}`);
    }
  }
  return urls;
}

/**
 * Fetch JS bundles in parallel batches and extract query IDs from each.
 */
async function fetchAndExtractBatch(
  urls: string[],
  ids: Record<string, string>,
  batchSize = 15,
): Promise<void> {
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((url) =>
        fetch(url, { headers: { 'user-agent': UA } }).then((r) => (r.ok ? r.text() : '')),
      ),
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        extractQueryIds(result.value, ids);
      }
    }
  }
}

/**
 * Extract GraphQL query IDs from X's compiled JavaScript bundles,
 * including lazily-loaded webpack chunks that contain bookmark operations.
 */
async function extractFromBundle(): Promise<Record<string, string>> {
  const pageResponse = await fetch('https://x.com', {
    headers: { 'user-agent': UA },
    redirect: 'follow',
  });

  if (!pageResponse.ok) {
    throw new Error(`Failed to fetch x.com: ${pageResponse.status}`);
  }

  const html = await pageResponse.text();

  // Find JS bundle URLs from script tags
  const scriptUrls: string[] = [];
  const scriptRegex = /src="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"]+\.js)"/g;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    scriptUrls.push(match[1]);
  }

  if (scriptUrls.length === 0) {
    throw new Error('No X JS bundles found. X may have changed their page structure.');
  }

  // Phase 1: Extract query IDs from main bundles
  const ids: Record<string, string> = {};
  for (const url of scriptUrls) {
    const jsResponse = await fetch(url, { headers: { 'user-agent': UA } });
    if (!jsResponse.ok) continue;
    extractQueryIds(await jsResponse.text(), ids);
  }

  // Phase 2: Discover lazy-loaded chunk URLs from the inline webpack runtime
  const lazyChunkUrls = discoverLazyChunkUrls(html);

  if (lazyChunkUrls.length > 0) {
    // Prioritize chunks whose URL contains "Bookmark" (case-insensitive)
    const bookmarkChunks = lazyChunkUrls.filter((u) => /bookmark/i.test(u));
    const otherChunks = lazyChunkUrls.filter((u) => !/bookmark/i.test(u));

    if (bookmarkChunks.length > 0) {
      process.stderr.write(`  Scanning ${bookmarkChunks.length} bookmark-related chunks...\n`);
      await fetchAndExtractBatch(bookmarkChunks, ids);
    }

    // If we still don't have all the IDs we need, scan remaining chunks
    const NEEDED: OperationName[] = ['Bookmarks', 'BookmarkFoldersSlice', 'BookmarkFolderTimeline', 'TweetDetail', 'TweetResultByRestId'];
    const missing = NEEDED.filter((op) => !ids[op]);
    if (missing.length > 0 && otherChunks.length > 0) {
      process.stderr.write(`  Scanning ${otherChunks.length} additional chunks for ${missing.join(', ')}...\n`);
      await fetchAndExtractBatch(otherChunks, ids);
    }
  }

  return ids;
}

// Fallback IDs for operations in lazy-loaded webpack chunks that can't be
// auto-extracted from the main bundle. These may go stale when X deploys.
// When they do, set the env var override or extract via Chrome DevTools.
const FALLBACK_IDS: Partial<Record<OperationName, string>> = {
  Bookmarks: 'Z9GWmP0kP2dajyckAaDUBw',
  TweetResultByRestId: 'fHLDP3qFEjnTqhWBVvsREg',
};

// Env var name mapping for manual overrides
function envKey(operation: string): string {
  // Bookmarks → FT_BOOKMARKS_QUERY_ID
  // BookmarkFoldersSlice → FT_BOOKMARK_FOLDERS_SLICE_QUERY_ID
  // TweetDetail → FT_TWEET_DETAIL_QUERY_ID
  return `FT_${operation.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_QUERY_ID`;
}

/**
 * Get the query ID for a GraphQL operation.
 * Priority: env var → cache → extract from X's JS bundle.
 *
 * Note: Some operations (Bookmarks, BookmarkFolders) are in lazy-loaded
 * webpack chunks and may not be found via bundle extraction. For those,
 * set the env var (e.g. FT_BOOKMARKS_QUERY_ID=xxx).
 */
export async function getQueryId(operation: OperationName): Promise<string> {
  // 1. Env var override
  const ek = envKey(operation);
  const envVal = process.env[ek];
  if (envVal) return envVal;

  // 2. Check cache
  const cached = await loadCache();
  if (cached?.[operation]) return cached[operation];

  // 3. Extract from X's JS bundle
  process.stderr.write(`  Extracting GraphQL query IDs from x.com...\n`);
  const extracted = await extractFromBundle();

  // Save everything we found
  const merged = { ...(cached ?? {}), ...extracted };
  if (Object.keys(extracted).length > 0) {
    await saveCache(merged);
  }

  if (merged[operation]) {
    return merged[operation];
  }

  // 4. Try hardcoded fallback (for lazy-chunk operations)
  const fallback = FALLBACK_IDS[operation];
  if (fallback) return fallback;

  throw new Error(
    `Could not find query ID for "${operation}" in X's JS bundles.\n` +
    `This operation is in a lazily-loaded chunk not available from the main page.\n\n` +
    `To get it: open Chrome DevTools → Network tab → navigate to the\n` +
    `relevant page on x.com → filter for "${operation}" → copy the ID from the URL.\n\n` +
    `Then set: ${ek}=<id>\n` +
    `Or add to .env: ${ek}=<id>`
  );
}
