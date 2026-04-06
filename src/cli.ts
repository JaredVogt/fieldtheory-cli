#!/usr/bin/env node
import { Command } from 'commander';
import { syncTwitterBookmarks } from './bookmarks.js';
import { getBookmarkStatusView, formatBookmarkStatus } from './bookmarks-service.js';
import { runTwitterOAuthFlow } from './xauth.js';
import { loadEnv } from './config.js';
import { runGithubTokenCheck, type GithubTokenBindingReport, type GithubTokenCheckResult } from './github-check.js';
import { syncBookmarksGraphQL, listBookmarkFolders, resolveFolder } from './graphql-bookmarks.js';
import type { SyncProgress } from './graphql-bookmarks.js';
import {
  migrateLegacyData,
  reprocessBookmarks,
  retryBookmarks,
  syncBookmarksSequentially,
  type BatchProcessProgress,
  type SyncEngineProgress,
} from './bookmark-processor.js';
import {
  buildIndex,
  searchBookmarks,
  formatSearchResults,
  getStats,
  classifyAndRebuild,
  getCategoryCounts,
  sampleByCategory,
  getDomainCounts,
  listBookmarks,
  getBookmarkById,
  getThreadTweets,
  getBookmarkConversationId,
  listIncompleteBookmarks,
  listFailureEvents,
} from './bookmarks-db.js';
import { formatClassificationSummary } from './bookmark-classify.js';
import { classifyWithLlm, classifyDomainsWithLlm } from './bookmark-classify-llm.js';
import { renderViz } from './bookmarks-viz.js';
import { dataDir, ensureDataDir, isFirstRun, twitterBookmarksIndexPath } from './paths.js';
import fs from 'node:fs';

// ── Helpers ─────────────────────────────────────────────────────────────────

const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
let spinnerIdx = 0;

function renderProgress(status: SyncProgress, startTime: number): void {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const spin = SPINNER[spinnerIdx++ % SPINNER.length];
  const line = `  ${spin} Syncing bookmarks...  ${status.newAdded} new  \u2502  page ${status.page}  \u2502  ${elapsed}s`;
  process.stderr.write(`\r\x1b[K${line}`);
}

function renderDirectSyncProgress(status: SyncEngineProgress, startTime: number): void {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const spin = SPINNER[spinnerIdx++ % SPINNER.length];
  const activity = status.detail ?? status.stage ?? 'working';
  const line = `  ${spin} ${activity}...  ${status.completed} complete  \u2502  ${status.retryableFailed + status.terminalIncomplete} incomplete  \u2502  page ${status.page}  \u2502  ${elapsed}s`;
  process.stderr.write(`\r\x1b[K${line}`);
}

function renderBatchProgress(label: string, status: BatchProcessProgress, startTime: number): void {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const spin = SPINNER[spinnerIdx++ % SPINNER.length];
  const line = `  ${spin} ${label}...  ${status.processed + status.skipped}/${status.total}  \u2502  ${status.completed} complete  \u2502  ${status.retryableFailed + status.terminalIncomplete} incomplete  \u2502  ${elapsed}s`;
  process.stderr.write(`\r\x1b[K${line}`);
}

const FRIENDLY_STOP_REASONS: Record<string, string> = {
  'caught up to newest stored bookmark': 'All caught up \u2014 no new bookmarks since last sync.',
  'no new bookmarks (stale)': 'Sync complete \u2014 reached the end of new bookmarks.',
  'end of bookmarks': 'Sync complete \u2014 all bookmarks fetched.',
  'max runtime reached': 'Paused after 30 minutes. Run again to continue.',
  'max pages reached': 'Paused after reaching page limit. Run again to continue.',
  'target additions reached': 'Reached target bookmark count.',
};

function friendlyStopReason(raw?: string): string {
  if (!raw) return 'Sync complete.';
  return FRIENDLY_STOP_REASONS[raw] ?? `Sync complete \u2014 ${raw}`;
}

function failureHint(code?: string | null): string | null {
  switch (code) {
    case 'rate_limited':
    case 'github_rate_limited':
      return 'Rate limited. Wait and retry; for GitHub content, set GITHUB_TOKEN.';
    case 'github_unauthorized':
      return 'GitHub rejected the token. Check that GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN is valid.';
    case 'github_forbidden':
      return 'GitHub denied access. The token may lack scope, or the resource may be private.';
    case 'github_forbidden_or_token_missing':
      return 'GitHub denied access. Add a valid token or check access to the private repo/gist.';
    case 'github_readme_missing':
      return 'The repo does not expose a README at the expected path.';
    case 'github_readme_fetch_failed':
    case 'github_gist_fetch_failed':
    case 'github_api_error':
    case 'github_raw_error':
    case 'github_gist_api_error':
      return 'GitHub fetch failed transiently. Retry later and inspect network/API status if it keeps happening.';
    case 'github_gist_not_found':
      return 'The gist was not found or is inaccessible to the current token.';
    case 'github_gist_empty':
      return 'The gist exists but did not contain any readable files.';
    case 'http_403':
      return 'Forbidden or protected content. Check whether the current account can access it.';
    case 'http_404':
      return 'Missing or deleted content. This usually cannot be recovered automatically.';
    case 'download_failed':
    case 'transient_error':
      return 'Transient network failure. Retrying later should usually help.';
    case 'too_large':
      return 'Media exceeded the current size cap. Increase the media byte limit if you need it.';
    case 'unreadable_article':
      return 'The linked page did not yield readable content. This likely needs a fetch/parser improvement.';
    case 'content_unavailable':
      return 'The linked content was unavailable at fetch time. Retry if it should still exist.';
    case 'thread_missing':
      return 'TweetDetail returned no conversation payload. The post may be deleted/protected, or the parser missed a shape.';
    default:
      return null;
  }
}

function formatTokenSource(binding: GithubTokenBindingReport): string {
  if (binding.source === 'process') return 'shell environment';
  if (binding.source === 'file' && binding.path) return binding.path;
  return 'not found';
}

function renderGithubCheck(result: GithubTokenCheckResult): void {
  console.log('\n  GitHub token check\n');
  for (const binding of result.bindings) {
    const label = binding.selected ? `${binding.name} (active)` : binding.name;
    if (!binding.present) {
      console.log(`  ${label}: missing`);
      continue;
    }
    console.log(`  ${label}: present`);
    console.log(`    source: ${formatTokenSource(binding)}`);
    if (binding.fingerprint) console.log(`    fingerprint: sha256:${binding.fingerprint}`);
  }
  if (result.precedenceNote) console.log(`\n  note: ${result.precedenceNote}`);

  if (result.validation === 'skipped_missing_token') {
    console.log('\n  validation: skipped (no usable GitHub token found)');
    console.log('  checked:');
    console.log('    shell environment');
    for (const envPath of result.checkedPaths) console.log(`    ${envPath}`);
    console.log('\n  Set GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN, then rerun `ft github-check`.\n');
    return;
  }

  const statusLabel = (() => {
    switch (result.validation) {
      case 'valid':
        return 'valid';
      case 'unauthorized':
        return 'unauthorized';
      case 'forbidden':
        return 'forbidden';
      case 'rate_limited':
        return 'rate limited';
      case 'http_error':
        return 'http error';
      case 'network_error':
        return 'network error';
      default:
        return result.validation;
    }
  })();

  console.log(`\n  validation: ${statusLabel}${result.statusCode ? ` (${result.statusCode})` : ''}`);
  if (result.login) console.log(`  login: ${result.login}`);
  if (result.scopes.length > 0) console.log(`  scopes: ${result.scopes.join(', ')}`);
  if (result.rateLimitRemaining != null) console.log(`  rate limit remaining: ${result.rateLimitRemaining}`);
  if (result.message) console.log(`  message: ${result.message}`);

  if (result.validation === 'unauthorized') {
    console.log('  Fix the active token source above, then rerun sync or `ft retry`.');
  } else if (result.validation === 'forbidden') {
    console.log('  The token is recognized, but GitHub denied this request. Check token scopes or org restrictions.');
  } else if (result.validation === 'rate_limited') {
    console.log('  GitHub rate limited the request. Wait for reset or use a different token.');
  }
  console.log();
}

const LOGO = `
   \x1b[2m\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510\x1b[0m
   \x1b[2m\u2502\x1b[0m  \x1b[1mF i e l d   T h e o r y\x1b[0m    \x1b[2m\u2502\x1b[0m
   \x1b[2m\u2502\x1b[0m  \x1b[2mfieldtheory.dev/cli\x1b[0m        \x1b[2m\u2502\x1b[0m
   \x1b[2m\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518\x1b[0m`;

export function showWelcome(): void {
  console.log(LOGO);
  console.log(`
  Save a local copy of your X/Twitter bookmarks. Search them,
  classify them, and make them available to any AI agent.
  Your data never leaves your machine.

  Get started:

    1. Open Google Chrome and log into x.com
    2. Run: ft sync

  Data will be stored at: ${dataDir()}
`);
}

export async function showDashboard(): Promise<void> {
  console.log(LOGO);
  try {
    const view = await getBookmarkStatusView();
    const ago = view.lastUpdated ? timeAgo(view.lastUpdated) : 'never';
    console.log(`
  \x1b[1m${view.bookmarkCount.toLocaleString()}\x1b[0m bookmarks  \x1b[2m\u2502\x1b[0m  last synced \x1b[1m${ago}\x1b[0m  \x1b[2m\u2502\x1b[0m  ${dataDir()}
`);

    if (fs.existsSync(twitterBookmarksIndexPath())) {
      const counts = await getCategoryCounts();
      const cats = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 7);
      if (cats.length > 0) {
        const catLine = cats.map(([c, n]) => `${c} (${n})`).join(' \u00b7 ');
        console.log(`  \x1b[2m${catLine}\x1b[0m`);
      }
    }

    console.log(`
  \x1b[2mSync now:\x1b[0m     ft sync
  \x1b[2mSearch:\x1b[0m       ft search "query"
  \x1b[2mExplore:\x1b[0m      ft viz
  \x1b[2mAll commands:\x1b[0m  ft --help
`);
  } catch {
    console.log(`
  Data: ${dataDir()}

  Run: ft sync
`);
  }
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function showSyncWelcome(): void {
  console.log(`
  Make sure Google Chrome is open and logged into x.com.
  Your Chrome session is used to authenticate \u2014 no passwords
  are stored or transmitted.
`);
}

/** Check that bookmarks have been synced. Returns true if data exists. */
function requireData(): boolean {
  if (isFirstRun()) {
    console.log(`
  No bookmarks synced yet.

  Get started:

    1. Open Google Chrome and log into x.com
    2. Run: ft sync
`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/** Check that the search index exists. Returns true if it does. */
function requireIndex(): boolean {
  if (!requireData()) return false;
  if (!fs.existsSync(twitterBookmarksIndexPath())) {
    console.log(`
  Search index not built yet.

  Run: ft index
`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/** Wrap an async action with graceful error handling. */
function safe(fn: (...args: any[]) => Promise<void>): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`\n  Error: ${msg}\n`);
      process.exitCode = 1;
    }
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function buildCli() {
  const program = new Command();

  async function rebuildIndex(added: number): Promise<number> {
    if (added <= 0) return 0;
    process.stderr.write('  Building search index...\n');
    const idx = await buildIndex();
    process.stderr.write(`  \u2713 ${idx.recordCount} bookmarks indexed (${idx.newRecords} new)\n`);
    return idx.newRecords;
  }

  async function classifyNew(): Promise<void> {
    const start = Date.now();
    process.stderr.write('  Classifying new bookmarks (categories)...\n');
    const catResult = await classifyWithLlm({
      onBatch: (done: number, total: number) => {
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const elapsed = Math.round((Date.now() - start) / 1000);
        process.stderr.write(`  Categories: ${done}/${total} (${pct}%) \u2502 ${elapsed}s elapsed\n`);
      },
    });
    if (catResult.classified > 0) {
      process.stderr.write(`  \u2713 ${catResult.classified} categorized\n`);
    }

    const domStart = Date.now();
    process.stderr.write('  Classifying new bookmarks (domains)...\n');
    const domResult = await classifyDomainsWithLlm({
      all: false,
      onBatch: (done: number, total: number) => {
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const elapsed = Math.round((Date.now() - domStart) / 1000);
        process.stderr.write(`  Domains: ${done}/${total} (${pct}%) \u2502 ${elapsed}s elapsed\n`);
      },
    });
    if (domResult.classified > 0) {
      process.stderr.write(`  \u2713 ${domResult.classified} domains assigned\n`);
    }
  }

  program
    .name('ft')
    .description('Self-custody for your X/Twitter bookmarks. Sync, search, classify, and explore locally.')
    .version('1.2.0')
    .showHelpAfterError()
    .hook('preAction', () => {
      console.log(LOGO);
    });

  // ── sync ────────────────────────────────────────────────────────────────

  program
    .command('sync')
    .description('Sync bookmarks from X into your local database')
    .option('--api', 'Use OAuth v2 API instead of Chrome session', false)
    .option('--full', 'Full crawl instead of incremental sync', false)
    .option('--classify', 'Classify new bookmarks with LLM after syncing', false)
    .option('--all', 'Backward-compatible alias for sync plus classification', false)
    .option('--max-pages <n>', 'Max pages to fetch', (v: string) => Number(v), 500)
    .option('--target-adds <n>', 'Stop after N new bookmarks', (v: string) => Number(v))
    .option('--delay-ms <n>', 'Delay between requests in ms', (v: string) => Number(v), 600)
    .option('--max-minutes <n>', 'Max runtime in minutes', (v: string) => Number(v), 30)
    .option('--chrome-user-data-dir <path>', 'Chrome user-data directory')
    .option('--chrome-profile-directory <name>', 'Chrome profile name')
    .option('--folder [name-url-or-id]', 'Sync a bookmark folder (by name, URL, or ID; interactive picker if omitted)')
    .action(async (options) => {
      const firstRun = isFirstRun();
      if (firstRun) showSyncWelcome();
      ensureDataDir();

      try {
        const useApi = Boolean(options.api);
        const mode = Boolean(options.full) ? 'full' : 'incremental';

        if (useApi) {
          const result = await syncTwitterBookmarks(mode, {
            targetAdds: typeof options.targetAdds === 'number' && !Number.isNaN(options.targetAdds) ? options.targetAdds : undefined,
          });
          console.log(`\n  \u2713 ${result.added} new bookmarks synced (${result.totalBookmarks} total)`);
          console.log(`  \u2713 Data: ${dataDir()}\n`);
          const newCount = await rebuildIndex(result.added);
          if (options.classify && newCount > 0) {
            await classifyNew();
          }
        } else {
          // Resolve folder if --folder specified
          let folderId: string | undefined;
          if (options.folder !== undefined) {
            // Need Chrome auth to resolve folder names
            const { loadChromeSessionConfig } = await import('./config.js');
            const { extractChromeXCookies } = await import('./chrome-cookies.js');
            const chromeConfig = loadChromeSessionConfig();
            const chromeDir = options.chromeUserDataDir ? String(options.chromeUserDataDir) : chromeConfig.chromeUserDataDir;
            const chromeProfile = options.chromeProfileDirectory ? String(options.chromeProfileDirectory) : chromeConfig.chromeProfileDirectory;
            const cookies = extractChromeXCookies(chromeDir, chromeProfile);

            const resolved = await resolveFolder(options.folder, cookies.csrfToken, cookies.cookieHeader);
            if (resolved === 'picker') {
              const folders = await listBookmarkFolders(cookies.csrfToken, cookies.cookieHeader);
              if (folders.length === 0) {
                console.log('  No bookmark folders found.');
                return;
              }
              const { createInterface } = await import('node:readline');
              console.log('\n  Bookmark Folders');
              console.log('  ' + '\u2500'.repeat(40));
              for (let i = 0; i < folders.length; i++) {
                const f = folders[i];
                const count = f.bookmarkCount != null ? ` (${f.bookmarkCount})` : '';
                console.log(`  ${String(i + 1).padStart(2)}. ${f.name}${count}`);
              }
              console.log();
              const rl = createInterface({ input: process.stdin, output: process.stderr });
              const answer = await new Promise<string>((resolve) => {
                rl.question(`  Select folder [1-${folders.length}]: `, resolve);
              });
              rl.close();
              const idx = parseInt(answer.trim(), 10) - 1;
              if (idx < 0 || idx >= folders.length) {
                console.log('  Invalid selection.');
                process.exitCode = 1;
                return;
              }
              folderId = folders[idx].id;
              console.log(`\n  Syncing "${folders[idx].name}"...\n`);
            } else {
              folderId = resolved.id;
              console.log(`\n  Syncing folder "${resolved.name}"...\n`);
            }
          }

          const startTime = Date.now();
          loadEnv();
          const hasGithubToken = Boolean(process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN);
          console.log('  Preparing direct sync (loading Chrome session, query IDs, and local state)...');
          console.log(`  GitHub token: ${hasGithubToken ? 'present' : 'missing'}`);
          const result = await syncBookmarksSequentially({
            incremental: !Boolean(options.full),
            maxPages: Number(options.maxPages) || 500,
            targetAdds: typeof options.targetAdds === 'number' && !Number.isNaN(options.targetAdds) ? options.targetAdds : undefined,
            delayMs: Number(options.delayMs) || 600,
            maxMinutes: Number(options.maxMinutes) || 30,
            maxBytes: 50 * 1024 * 1024,
            chromeUserDataDir: options.chromeUserDataDir ? String(options.chromeUserDataDir) : undefined,
            chromeProfileDirectory: options.chromeProfileDirectory ? String(options.chromeProfileDirectory) : undefined,
            folderId,
            onProgress: (status: SyncEngineProgress) => {
              renderDirectSyncProgress(status, startTime);
              if (status.done) process.stderr.write('\n');
            },
          });

          console.log(`\n  \u2713 ${result.completed} bookmarks fully completed`);
          console.log(`  ${friendlyStopReason(result.stopReason)}`);
          if (result.discovered > 0) console.log(`  ${result.discovered} new bookmarks discovered`);
          if (result.retryableFailed > 0) console.log(`  ${result.retryableFailed} retryable incomplete`);
          if (result.terminalIncomplete > 0) console.log(`  ${result.terminalIncomplete} terminal incomplete`);
          if (result.retryableFailed > 0 || result.terminalIncomplete > 0) {
            console.log('  Run `ft failures` to inspect why bookmarks are incomplete.');
          }
          console.log(`  \u2713 Data: ${dataDir()}\n`);

          const doClassify = Boolean(options.all) || Boolean(options.classify);
          if (doClassify && result.discovered > 0) {
            await classifyNew();
          }
        }

        if (firstRun) {
          console.log(`\n  Next steps:`);
          console.log(`        ft classify              Classify by category and domain (LLM)`);
          console.log(`        ft classify --regex      Classify by category (simple)`);
          console.log(`\n  Explore:`);
          console.log(`        ft search "machine learning"`);
          console.log(`        ft viz`);
          console.log(`        ft categories`);
          console.log(`\n  You can also just tell Claude to use the ft CLI to search and`);
          console.log(`  explore your bookmarks. It already knows how.\n`);
        }
      } catch (err) {
        const msg = (err as Error).message;
        if (firstRun && (msg.includes('cookie') || msg.includes('Cookie') || msg.includes('Keychain'))) {
          console.log(`
  Couldn't connect to your Chrome session.

  To sync your bookmarks:

    1. Open Google Chrome
    2. Go to x.com and make sure you're logged in
    3. Run: ft sync

  If you use multiple Chrome profiles, specify which one:
    ft sync --chrome-profile-directory "Profile 1"
`);
        } else {
          console.error(`\n  Error: ${msg}\n`);
        }
        process.exitCode = 1;
      }
    });

  // ── search ──────────────────────────────────────────────────────────────

  program
    .command('search')
    .description('Full-text search across bookmarks')
    .argument('<query>', 'Search query (supports FTS5 syntax: AND, OR, NOT, "exact phrase")')
    .option('--author <handle>', 'Filter by author handle')
    .option('--after <date>', 'Bookmarks posted after this date (YYYY-MM-DD)')
    .option('--before <date>', 'Bookmarks posted before this date (YYYY-MM-DD)')
    .option('--limit <n>', 'Max results', (v: string) => Number(v), 20)
    .action(safe(async (query: string, options) => {
      if (!requireIndex()) return;
      const results = await searchBookmarks({
        query,
        author: options.author ? String(options.author) : undefined,
        after: options.after ? String(options.after) : undefined,
        before: options.before ? String(options.before) : undefined,
        limit: Number(options.limit) || 20,
      });
      console.log(formatSearchResults(results));
    }));

  // ── list ────────────────────────────────────────────────────────────────

  program
    .command('list')
    .description('List bookmarks with filters')
    .option('--query <query>', 'Text query (FTS5 syntax)')
    .option('--author <handle>', 'Filter by author handle')
    .option('--after <date>', 'Posted after (YYYY-MM-DD)')
    .option('--before <date>', 'Posted before (YYYY-MM-DD)')
    .option('--category <category>', 'Filter by category')
    .option('--domain <domain>', 'Filter by domain')
    .option('--limit <n>', 'Max results', (v: string) => Number(v), 30)
    .option('--offset <n>', 'Offset into results', (v: string) => Number(v), 0)
    .option('--json', 'JSON output')
    .action(safe(async (options) => {
      if (!requireIndex()) return;
      const items = await listBookmarks({
        query: options.query ? String(options.query) : undefined,
        author: options.author ? String(options.author) : undefined,
        after: options.after ? String(options.after) : undefined,
        before: options.before ? String(options.before) : undefined,
        category: options.category ? String(options.category) : undefined,
        domain: options.domain ? String(options.domain) : undefined,
        limit: Number(options.limit) || 30,
        offset: Number(options.offset) || 0,
      });
      if (options.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      for (const item of items) {
        const tags = [item.primaryCategory, item.primaryDomain].filter(Boolean).join(' \u00b7 ');
        const summary = item.text.length > 120 ? `${item.text.slice(0, 117)}...` : item.text;
        console.log(`${item.id}  ${item.authorHandle ? `@${item.authorHandle}` : '@?'}  ${item.postedAt?.slice(0, 10) ?? '?'}${tags ? `  ${tags}` : ''}`);
        console.log(`  ${summary}`);
        console.log(`  ${item.url}`);
        console.log();
      }
    }));

  // ── show ─────────────────────────────────────────────────────────────────

  program
    .command('show')
    .description('Show one bookmark in detail')
    .argument('<id>', 'Bookmark id')
    .option('--json', 'JSON output')
    .option('--no-thread', 'Suppress thread context')
    .action(safe(async (id: string, options) => {
      if (!requireIndex()) return;
      const item = await getBookmarkById(String(id));
      if (!item) {
        console.log(`  Bookmark not found: ${String(id)}`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(item, null, 2));
        return;
      }
      console.log(`${item.id} \u00b7 ${item.authorHandle ? `@${item.authorHandle}` : '@?'}`);
      console.log(item.url);
      console.log(item.text);
      if (item.links.length) console.log(`links: ${item.links.join(', ')}`);
      if (item.categories) console.log(`categories: ${item.categories}`);
      if (item.domains) console.log(`domains: ${item.domains}`);

      // Show thread context if available
      if (options.thread !== false) {
        const convId = await getBookmarkConversationId(String(id));
        if (convId) {
          const threadTweets = await getThreadTweets(convId);
          if (threadTweets.length > 1) {
            console.log(`\n\u2500\u2500 Thread (${threadTweets.length} tweets) ${'─'.repeat(Math.max(0, 40 - String(threadTweets.length).length))}`);
            for (const t of threadTweets) {
              const marker = t.tweetId === item.id ? '\u2605 ' : '  ';
              const author = t.authorHandle ? `@${t.authorHandle}` : '@?';
              const date = t.postedAt ? t.postedAt.slice(0, 10) : '?';
              const text = t.text.length > 120 ? t.text.slice(0, 117) + '...' : t.text;
              console.log(`${marker}[${t.threadPosition}] ${author} \u00b7 ${date}`);
              console.log(`${marker}    ${text}`);
            }
          }
        }
      }
    }));

  // ── stats ───────────────────────────────────────────────────────────────

  program
    .command('stats')
    .description('Aggregate statistics from your bookmarks')
    .action(safe(async () => {
      if (!requireIndex()) return;
      const stats = await getStats();
      console.log(`Bookmarks: ${stats.totalBookmarks}`);
      console.log(`Unique authors: ${stats.uniqueAuthors}`);
      console.log(`Date range: ${stats.dateRange.earliest?.slice(0, 10) ?? '?'} to ${stats.dateRange.latest?.slice(0, 10) ?? '?'}`);
      console.log(`\nTop authors:`);
      for (const a of stats.topAuthors) console.log(`  @${a.handle}: ${a.count}`);
      console.log(`\nLanguages:`);
      for (const l of stats.languageBreakdown) console.log(`  ${l.language}: ${l.count}`);
    }));

  // ── viz ─────────────────────────────────────────────────────────────────

  program
    .command('viz')
    .description('Visual dashboard of your bookmarking patterns')
    .action(safe(async () => {
      if (!requireIndex()) return;
      console.log(await renderViz());
    }));

  // ── classify ────────────────────────────────────────────────────────────

  program
    .command('classify')
    .description('Classify bookmarks by category and domain using LLM (requires claude or codex CLI)')
    .option('--regex', 'Use simple regex classification instead of LLM')
    .action(safe(async (options) => {
      if (!requireData()) return;
      if (options.regex) {
        process.stderr.write('Classifying bookmarks (regex)...\n');
        const result = await classifyAndRebuild();
        console.log(`Indexed ${result.recordCount} bookmarks \u2192 ${result.dbPath}`);
        console.log(formatClassificationSummary(result.summary));
      } else {
        let catStart = Date.now();
        process.stderr.write('Classifying categories with LLM (batches of 50, ~2 min per batch)...\n');
        const catResult = await classifyWithLlm({
          onBatch: (done: number, total: number) => {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            const elapsed = Math.round((Date.now() - catStart) / 1000);
            process.stderr.write(`  Categories: ${done}/${total} (${pct}%) \u2502 ${elapsed}s elapsed\n`);
          },
        });
        console.log(`\nEngine: ${catResult.engine}`);
        console.log(`Categories: ${catResult.classified}/${catResult.totalUnclassified} classified`);

        let domStart = Date.now();
        process.stderr.write('\nClassifying domains with LLM (batches of 50, ~2 min per batch)...\n');
        const domResult = await classifyDomainsWithLlm({
          all: false,
          onBatch: (done: number, total: number) => {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            const elapsed = Math.round((Date.now() - domStart) / 1000);
            process.stderr.write(`  Domains: ${done}/${total} (${pct}%) \u2502 ${elapsed}s elapsed\n`);
          },
        });
        console.log(`\nDomains: ${domResult.classified}/${domResult.totalUnclassified} classified`);
      }
    }));

  // ── classify-domains ────────────────────────────────────────────────────

  program
    .command('classify-domains')
    .description('Classify bookmarks by subject domain using LLM (ai, finance, etc.)')
    .option('--all', 'Re-classify all bookmarks, not just missing')
    .action(safe(async (options) => {
      if (!requireData()) return;
      const start = Date.now();
      process.stderr.write('Classifying bookmark domains with LLM (batches of 50, ~2 min per batch)...\n');
      const result = await classifyDomainsWithLlm({
        all: options.all ?? false,
        onBatch: (done: number, total: number) => {
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const elapsed = Math.round((Date.now() - start) / 1000);
          process.stderr.write(`  Domains: ${done}/${total} (${pct}%) \u2502 ${elapsed}s elapsed\n`);
        },
      });
      console.log(`\nDomains: ${result.classified}/${result.totalUnclassified} classified`);
    }));

  // ── categories ──────────────────────────────────────────────────────────

  program
    .command('categories')
    .description('Show category distribution')
    .action(safe(async () => {
      if (!requireIndex()) return;
      const counts = await getCategoryCounts();
      if (Object.keys(counts).length === 0) {
        console.log('  No categories found. Run: ft classify');
        return;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      for (const [cat, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        const pct = ((count / total) * 100).toFixed(1);
        console.log(`  ${cat.padEnd(14)} ${String(count).padStart(5)}  (${pct}%)`);
      }
    }));

  // ── domains ─────────────────────────────────────────────────────────────

  program
    .command('domains')
    .description('Show domain distribution')
    .action(safe(async () => {
      if (!requireIndex()) return;
      const counts = await getDomainCounts();
      if (Object.keys(counts).length === 0) {
        console.log('  No domains found. Run: ft classify-domains');
        return;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      for (const [dom, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        const pct = ((count / total) * 100).toFixed(1);
        console.log(`  ${dom.padEnd(20)} ${String(count).padStart(5)}  (${pct}%)`);
      }
    }));

  // ── index ───────────────────────────────────────────────────────────────

  program
    .command('index')
    .description('Rebuild the SQLite search index from the JSONL cache')
    .option('--force', 'Drop and rebuild from scratch (loses classifications)')
    .action(safe(async (options) => {
      if (!requireData()) return;
      process.stderr.write('Building search index...\n');
      const result = await buildIndex({ force: Boolean(options.force) });
      console.log(`Indexed ${result.recordCount} bookmarks (${result.newRecords} new) \u2192 ${result.dbPath}`);
    }));

  // ── auth ────────────────────────────────────────────────────────────────

  program
    .command('auth')
    .description('Set up OAuth for API-based sync (optional, needed for ft sync --api)')
    .action(safe(async () => {
      const result = await runTwitterOAuthFlow();
      console.log(`Saved token to ${result.tokenPath}`);
      if (result.scope) console.log(`Scope: ${result.scope}`);
    }));

  // ── status ──────────────────────────────────────────────────────────────

  program
    .command('status')
    .description('Show sync status and data location')
    .action(safe(async () => {
      if (!requireData()) return;
      const view = await getBookmarkStatusView();
      console.log(formatBookmarkStatus(view));
    }));

  // ── path ────────────────────────────────────────────────────────────────

  program
    .command('path')
    .description('Print the data directory path')
    .action(() => { console.log(dataDir()); });

  // ── sample ──────────────────────────────────────────────────────────────

  program
    .command('sample')
    .description('Sample bookmarks by category')
    .argument('<category>', 'Category: tool, security, technique, launch, research, opinion, commerce')
    .option('--limit <n>', 'Max results', (v: string) => Number(v), 10)
    .action(safe(async (category: string, options) => {
      if (!requireIndex()) return;
      const results = await sampleByCategory(category, Number(options.limit) || 10);
      if (results.length === 0) {
        console.log(`  No bookmarks found with category "${category}". Run: ft classify`);
        return;
      }
      for (const r of results) {
        const text = r.text.length > 120 ? r.text.slice(0, 120) + '...' : r.text;
        console.log(`[@${r.authorHandle ?? '?'}] ${text}`);
        console.log(`  ${r.url}  [${r.categories}]`);
        if (r.githubUrls) console.log(`  github: ${r.githubUrls}`);
        console.log();
      }
    }));

  // ── fetch-media ─────────────────────────────────────────────────────────

  program
    .command('fetch-media')
    .description('Reprocess bookmarks that are still missing thread media')
    .option('--limit <n>', 'Max bookmarks to process', (v: string) => Number(v), 100)
    .option('--max-bytes <n>', 'Per-asset byte limit', (v: string) => Number(v), 50 * 1024 * 1024)
    .option('--delay-ms <n>', 'Delay between requests in ms', (v: string) => Number(v), 600)
    .option('--max-minutes <n>', 'Max runtime in minutes', (v: string) => Number(v), 30)
    .option('--chrome-user-data-dir <path>', 'Chrome user-data directory')
    .option('--chrome-profile-directory <name>', 'Chrome profile name')
    .action(safe(async (options) => {
      if (!requireIndex()) return;
      await migrateLegacyData();
      const startTime = Date.now();
      const result = await reprocessBookmarks({
        step: 'media',
        limit: Number(options.limit) || 100,
        maxBytes: Number(options.maxBytes) || 50 * 1024 * 1024,
        delayMs: Number(options.delayMs) || 600,
        maxMinutes: Number(options.maxMinutes) || 30,
        chromeUserDataDir: options.chromeUserDataDir ? String(options.chromeUserDataDir) : undefined,
        chromeProfileDirectory: options.chromeProfileDirectory ? String(options.chromeProfileDirectory) : undefined,
        onProgress: (status: BatchProcessProgress) => {
          renderBatchProgress('Fetching media', status, startTime);
          if (status.done) process.stderr.write('\n');
        },
      });
      console.log(`\n  \u2713 ${result.completed} bookmarks completed`);
      if (result.retryableFailed > 0) console.log(`  ${result.retryableFailed} still retryable incomplete`);
      if (result.terminalIncomplete > 0) console.log(`  ${result.terminalIncomplete} still terminal incomplete`);
      if (result.skipped > 0) console.log(`  ${result.skipped} skipped`);
      if (result.stopReason !== 'completed' && result.stopReason !== 'no bookmarks matched') {
        console.log(`  ${result.stopReason}`);
      }
    }));

  // ── fetch-links ────────────────────────────────────────────────────

  program
    .command('fetch-links')
    .description('Reprocess bookmarks that are still missing fetched link content')
    .option('--limit <n>', 'Max bookmarks to process', (v: string) => Number(v))
    .option('--github-only', 'Only fetch GitHub repos and gists', false)
    .option('--delay-ms <n>', 'Delay between requests in ms', (v: string) => Number(v), 500)
    .option('--max-minutes <n>', 'Max runtime in minutes', (v: string) => Number(v), 30)
    .action(safe(async (options) => {
      if (!requireIndex()) return;
      await migrateLegacyData();
      const startTime = Date.now();
      const result = await reprocessBookmarks({
        step: 'links',
        limit: options.limit ? Number(options.limit) : undefined,
        githubOnly: Boolean(options.githubOnly),
        delayMs: Number(options.delayMs) || 500,
        maxMinutes: Number(options.maxMinutes) || 30,
        onProgress: (status: BatchProcessProgress) => {
          renderBatchProgress('Fetching links', status, startTime);
          if (status.done) process.stderr.write('\n');
        },
      });
      console.log(`\n  \u2713 ${result.completed} bookmarks completed`);
      if (result.retryableFailed > 0) console.log(`  ${result.retryableFailed} still retryable incomplete`);
      if (result.terminalIncomplete > 0) console.log(`  ${result.terminalIncomplete} still terminal incomplete`);
      if (result.skipped > 0) console.log(`  ${result.skipped} skipped`);
      if (Boolean(options.githubOnly)) console.log('  GitHub-only mode leaves non-GitHub links incomplete.');
      if (result.stopReason !== 'completed' && result.stopReason !== 'no bookmarks matched') {
        console.log(`  ${result.stopReason}`);
      }
    }));

  // ── threads ──────────────────────────────────────────────────────────

  program
    .command('threads')
    .description('Reprocess bookmarks whose full conversation is still incomplete')
    .option('--delay-ms <n>', 'Delay between requests in ms', (v: string) => Number(v), 600)
    .option('--max-threads <n>', 'Max bookmarks to process', (v: string) => Number(v))
    .option('--max-minutes <n>', 'Max runtime in minutes', (v: string) => Number(v), 15)
    .option('--chrome-user-data-dir <path>', 'Chrome user-data directory')
    .option('--chrome-profile-directory <name>', 'Chrome profile name')
    .action(safe(async (options) => {
      if (!requireIndex()) return;
      await migrateLegacyData();
      const startTime = Date.now();
      const result = await reprocessBookmarks({
        step: 'thread',
        delayMs: Number(options.delayMs) || 600,
        limit: options.maxThreads ? Number(options.maxThreads) : undefined,
        maxMinutes: Number(options.maxMinutes) || 15,
        chromeUserDataDir: options.chromeUserDataDir ? String(options.chromeUserDataDir) : undefined,
        chromeProfileDirectory: options.chromeProfileDirectory ? String(options.chromeProfileDirectory) : undefined,
        onProgress: (status: BatchProcessProgress) => {
          renderBatchProgress('Fetching threads', status, startTime);
          if (status.done) process.stderr.write('\n');
        },
      });
      console.log(`\n  \u2713 ${result.completed} bookmarks completed`);
      if (result.retryableFailed > 0) console.log(`  ${result.retryableFailed} still retryable incomplete`);
      if (result.terminalIncomplete > 0) console.log(`  ${result.terminalIncomplete} still terminal incomplete`);
      if (result.skipped > 0) console.log(`  ${result.skipped} skipped`);
      if (result.stopReason !== 'completed' && result.stopReason !== 'no bookmarks matched') {
        console.log(`  ${result.stopReason}`);
      }
    }));

  // ── refresh ─────────────────────────────────────────────────────────

  program
    .command('refresh')
    .description('Reprocess bookmarks whose core TweetDetail data is incomplete')
    .option('--delay-ms <n>', 'Delay between requests in ms', (v: string) => Number(v), 600)
    .option('--max-minutes <n>', 'Max runtime in minutes', (v: string) => Number(v), 30)
    .option('--force', 'Reprocess all bookmarks through the direct pipeline', false)
    .option('--chrome-user-data-dir <path>', 'Chrome user-data directory')
    .option('--chrome-profile-directory <name>', 'Chrome profile name')
    .action(safe(async (options) => {
      if (!requireIndex()) return;
      await migrateLegacyData();
      const startTime = Date.now();
      const result = await reprocessBookmarks({
        step: 'core',
        delayMs: Number(options.delayMs) || 600,
        maxMinutes: Number(options.maxMinutes) || 30,
        force: Boolean(options.force),
        includeTerminal: Boolean(options.force),
        chromeUserDataDir: options.chromeUserDataDir ? String(options.chromeUserDataDir) : undefined,
        chromeProfileDirectory: options.chromeProfileDirectory ? String(options.chromeProfileDirectory) : undefined,
        onProgress: (status: BatchProcessProgress) => {
          renderBatchProgress('Refreshing', status, startTime);
          if (status.done) process.stderr.write('\n');
        },
      });
      console.log(`\n  \u2713 ${result.completed} bookmarks completed`);
      if (result.retryableFailed > 0) console.log(`  ${result.retryableFailed} still retryable incomplete`);
      if (result.terminalIncomplete > 0) console.log(`  ${result.terminalIncomplete} still terminal incomplete`);
      if (result.skipped > 0) console.log(`  ${result.skipped} skipped`);
      if (result.stopReason !== 'completed' && result.stopReason !== 'no bookmarks matched') {
        console.log(`  ${result.stopReason}`);
      }
    }));

  // ── hydrate ─────────────────────────────────────────────────────────

  program
    .command('hydrate')
    .description('Re-run bookmarks through the direct per-bookmark pipeline')
    .option('--delay-ms <n>', 'Delay between Twitter API requests in ms', (v: string) => Number(v), 600)
    .option('--max-minutes <n>', 'Max total runtime in minutes', (v: string) => Number(v), 60)
    .option('--limit <n>', 'Max bookmarks to process', (v: string) => Number(v))
    .option('--chrome-user-data-dir <path>', 'Chrome user-data directory')
    .option('--chrome-profile-directory <name>', 'Chrome profile name')
    .option('--force', 'Reprocess all bookmarks, including previously complete ones', false)
    .action(safe(async (options) => {
      if (!requireIndex()) return;
      await migrateLegacyData();
      const startTime = Date.now();
      const result = await reprocessBookmarks({
        step: 'all',
        delayMs: Number(options.delayMs) || 600,
        maxMinutes: Number(options.maxMinutes) || 60,
        force: Boolean(options.force),
        includeTerminal: Boolean(options.force),
        limit: options.limit ? Number(options.limit) : undefined,
        chromeUserDataDir: options.chromeUserDataDir ? String(options.chromeUserDataDir) : undefined,
        chromeProfileDirectory: options.chromeProfileDirectory ? String(options.chromeProfileDirectory) : undefined,
        onProgress: (status: BatchProcessProgress) => {
          renderBatchProgress('Hydrating', status, startTime);
          if (status.done) process.stderr.write('\n');
        },
      });

      console.log(`\n  \u2713 ${result.completed} bookmarks completed`);
      if (result.retryableFailed > 0) console.log(`  ${result.retryableFailed} still retryable incomplete`);
      if (result.terminalIncomplete > 0) console.log(`  ${result.terminalIncomplete} still terminal incomplete`);
      if (result.skipped > 0) console.log(`  ${result.skipped} skipped`);
      if (result.stopReason !== 'completed' && result.stopReason !== 'no bookmarks matched') {
        console.log(`  ${result.stopReason}`);
      }
      console.log();
    }));

  // ── incomplete ───────────────────────────────────────────────────────

  program
    .command('incomplete')
    .description('List bookmarks that are not fully complete under the direct sync pipeline')
    .option('--limit <n>', 'Max bookmarks to show', (v: string) => Number(v), 50)
    .option('--json', 'JSON output')
    .action(safe(async (options) => {
      if (!requireIndex()) return;
      await migrateLegacyData();
      const items = await listIncompleteBookmarks(Number(options.limit) || 50);
      if (options.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        console.log('  No incomplete bookmarks.');
        return;
      }
      for (const item of items) {
        const summary = item.text.length > 100 ? `${item.text.slice(0, 97)}...` : item.text;
        console.log(`${item.id}  ${item.processingState}  core:${item.coreStatus} thread:${item.threadStatus} media:${item.mediaStatus} links:${item.linksStatus}`);
        console.log(`  ${item.authorHandle ? `@${item.authorHandle}` : '@?'}  ${summary}`);
        if (item.lastErrorStep || item.lastErrorCode || item.lastErrorMessage) {
          const parts = [item.lastErrorStep ?? 'unknown', item.lastErrorCode ?? null].filter(Boolean);
          console.log(`  last error: ${parts.join('/')} ${item.lastErrorMessage ? `— ${item.lastErrorMessage}` : ''}`.trim());
          const hint = failureHint(item.lastErrorCode);
          if (hint) console.log(`  hint: ${hint}`);
        }
        if (item.nextRetryAt) console.log(`  next retry: ${item.nextRetryAt}`);
        console.log(`  ${item.url}`);
        console.log();
      }
    }));

  // ── failures ──────────────────────────────────────────────────────────

  program
    .command('failures')
    .description('Show recent failure events with retryability and likely fixes')
    .option('--limit <n>', 'Max failures to show', (v: string) => Number(v), 50)
    .option('--bookmark <id>', 'Filter to one bookmark id')
    .option('--retryable', 'Only show retryable failures', false)
    .option('--json', 'JSON output')
    .action(safe(async (options) => {
      if (!requireIndex()) return;
      await migrateLegacyData();
      const items = await listFailureEvents({
        limit: Number(options.limit) || 50,
        bookmarkId: options.bookmark ? String(options.bookmark) : undefined,
        retryableOnly: Boolean(options.retryable),
      });
      if (options.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        console.log('  No failure events found.');
        return;
      }
      for (const item of items) {
        const summary = item.text.length > 100 ? `${item.text.slice(0, 97)}...` : item.text;
        console.log(`${item.occurredAt}  ${item.bookmarkId}  ${item.retryable ? 'retryable' : 'terminal'}  ${item.step}/${item.failureCode}`);
        console.log(`  ${item.authorHandle ? `@${item.authorHandle}` : '@?'}  ${summary}`);
        console.log(`  ${item.failureMessage}`);
        if (item.targetRef) console.log(`  target: ${item.targetKind}  ${item.targetRef}`);
        const hint = failureHint(item.failureCode);
        if (hint) console.log(`  hint: ${hint}`);
        console.log(`  ${item.url}`);
        console.log();
      }
    }));

  // ── github-check ──────────────────────────────────────────────────────

  program
    .command('github-check')
    .description('Inspect and validate the GitHub token used for repo and gist link fetching')
    .option('--json', 'JSON output')
    .action(safe(async (options) => {
      const result = await runGithubTokenCheck();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      renderGithubCheck(result);
    }));

  // ── retry ────────────────────────────────────────────────────────────

  program
    .command('retry')
    .description('Retry incomplete bookmarks under the direct sync pipeline')
    .argument('[bookmarkIds...]', 'Specific bookmark ids to retry')
    .option('--all', 'Retry all incomplete bookmarks, including terminal incomplete ones', false)
    .option('--delay-ms <n>', 'Delay between Twitter API requests in ms', (v: string) => Number(v), 600)
    .option('--chrome-user-data-dir <path>', 'Chrome user-data directory')
    .option('--chrome-profile-directory <name>', 'Chrome profile name')
    .action(safe(async (bookmarkIds: string[], options) => {
      if (!requireIndex()) return;
      await migrateLegacyData();
      const result = await retryBookmarks({
        bookmarkIds: bookmarkIds.length > 0 ? bookmarkIds.map(String) : undefined,
        includeTerminal: Boolean(options.all) || bookmarkIds.length > 0,
        delayMs: Number(options.delayMs) || 600,
        chromeUserDataDir: options.chromeUserDataDir ? String(options.chromeUserDataDir) : undefined,
        chromeProfileDirectory: options.chromeProfileDirectory ? String(options.chromeProfileDirectory) : undefined,
      });
      console.log(`\n  \u2713 ${result.completed} bookmarks completed`);
      if (result.retryableFailed > 0) console.log(`  ${result.retryableFailed} still retryable incomplete`);
      if (result.terminalIncomplete > 0) console.log(`  ${result.terminalIncomplete} still terminal incomplete`);
      if (result.skipped > 0) console.log(`  ${result.skipped} skipped`);
      console.log();
    }));

  // ── export ──────────────────────────────────────────────────────────

  program
    .command('export')
    .description('Export bookmarks to Obsidian-compatible Markdown files')
    .option('--output <dir>', 'Output directory (one-time override)')
    .option('--set-output <dir>', 'Save output directory for future runs')
    .option('--force', 'Re-export already exported bookmarks', false)
    .option('--limit <n>', 'Max bookmarks to export', (v: string) => Number(v))
    .option('--author <handle>', 'Filter by author handle')
    .option('--category <category>', 'Filter by category')
    .option('--domain <domain>', 'Filter by domain')
    .option('--after <date>', 'Only bookmarks posted after (YYYY-MM-DD)')
    .option('--before <date>', 'Only bookmarks posted before (YYYY-MM-DD)')
    .option('--skip-threads', 'Export even if threads not yet fetched', false)
    .option('--dry-run', 'Preview what would be exported without writing files', false)
    .action(safe(async (options) => {
      if (!requireIndex()) return;
      const { exportBookmarksToMarkdown } = await import('./export-markdown.js');

      const result = await exportBookmarksToMarkdown({
        outputDir: options.output ? String(options.output) : undefined,
        setOutput: options.setOutput ? String(options.setOutput) : undefined,
        force: !!options.force,
        limit: options.limit ? Number(options.limit) : undefined,
        author: options.author ? String(options.author) : undefined,
        category: options.category ? String(options.category) : undefined,
        domain: options.domain ? String(options.domain) : undefined,
        after: options.after ? String(options.after) : undefined,
        before: options.before ? String(options.before) : undefined,
        skipThreads: !!options.skipThreads,
        dryRun: !!options.dryRun,
        onProgress: (processed, total) => {
          const spin = SPINNER[spinnerIdx++ % SPINNER.length];
          process.stderr.write(`\r\x1b[K  ${spin} Exporting...  ${processed}/${total}`);
        },
      });

      if (result.dryRun) {
        console.log(`\n  Dry run: ${result.exported} bookmarks would be exported`);
        console.log(`  Output: ${result.outputDir}`);
        return;
      }

      process.stderr.write('\r\x1b[K');
      if (result.exported === 0 && result.errors === 0) {
        console.log('  Nothing to export.');
      } else {
        console.log(`  \u2713 ${result.exported} bookmarks exported to ${result.outputDir}`);
        if (result.errors > 0) console.log(`  ${result.errors} errors`);
      }
    }));

  // ── folders ─────────────────────────────────────────────────────────

  program
    .command('folders')
    .description('List your X bookmark folders')
    .option('--json', 'JSON output')
    .option('--chrome-user-data-dir <path>', 'Chrome user-data directory')
    .option('--chrome-profile-directory <name>', 'Chrome profile name')
    .action(safe(async (options) => {
      const { loadChromeSessionConfig } = await import('./config.js');
      const { extractChromeXCookies } = await import('./chrome-cookies.js');
      const chromeConfig = loadChromeSessionConfig();
      const chromeDir = options.chromeUserDataDir ? String(options.chromeUserDataDir) : chromeConfig.chromeUserDataDir;
      const chromeProfile = options.chromeProfileDirectory ? String(options.chromeProfileDirectory) : chromeConfig.chromeProfileDirectory;
      const cookies = extractChromeXCookies(chromeDir, chromeProfile);

      const folders = await listBookmarkFolders(cookies.csrfToken, cookies.cookieHeader);

      if (options.json) {
        console.log(JSON.stringify(folders, null, 2));
        return;
      }

      if (folders.length === 0) {
        console.log('  No bookmark folders found.');
        return;
      }

      console.log('\n  Bookmark Folders');
      console.log('  ' + '\u2500'.repeat(40));
      for (const f of folders) {
        const count = f.bookmarkCount != null ? String(f.bookmarkCount).padStart(4) : '   ?';
        console.log(`  ${count}  ${f.name}`);
        console.log(`        ${f.id}`);
      }
      console.log();
    }));

  // ── hidden backward-compat aliases ────────────────────────────────────

  const bookmarksAlias = program.command('bookmarks').description('(alias) Bookmark commands').helpOption(false);
  for (const cmd of ['sync', 'search', 'list', 'show', 'stats', 'viz', 'classify', 'classify-domains',
    'categories', 'domains', 'index', 'auth', 'status', 'path', 'sample', 'fetch-media', 'fetch-links',
    'threads', 'refresh', 'hydrate', 'export', 'folders', 'incomplete', 'failures', 'github-check', 'retry']) {
    bookmarksAlias.command(cmd).description(`Alias for: ft ${cmd}`).allowUnknownOption(true)
      .action(async () => {
        const args = ['node', 'ft', cmd, ...process.argv.slice(4)];
        await program.parseAsync(args);
      });
  }
  bookmarksAlias.command('enable').description('Alias for: ft sync').action(async () => {
    const args = ['node', 'ft', 'sync', ...process.argv.slice(4)];
    await program.parseAsync(args);
  });

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildCli().parseAsync(process.argv);
}
