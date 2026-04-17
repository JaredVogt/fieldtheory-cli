# Jared's Custom README — Field Theory CLI

This documents both the base Field Theory CLI and all custom additions on the `jared_custom` branch.

---

## What is Field Theory CLI?

Self-custody for X/Twitter bookmarks. Syncs bookmarks locally, indexes them with SQLite FTS5, classifies them, and makes them searchable from the terminal or any AI agent with shell access.

**Install:** `npm install -g fieldtheory`  
**Requires:** Node.js 20+, Google Chrome (for session sync)  
**Data:** `~/.ft-bookmarks/`  
**Repo:** [github.com/afar1/fieldtheory-cli](https://github.com/afar1/fieldtheory-cli)

```bash
ft sync                          # sync bookmarks (Chrome session)
ft search "distributed systems"  # full-text search
ft viz                           # terminal dashboard
```

---

## Commands

| Command | Description |
|---------|-------------|
| `ft sync` | Discover and fully process bookmarks one at a time (tweet, thread, media, links) |
| `ft sync --classify` | Sync then classify new bookmarks with LLM |
| `ft sync --full` | Full history crawl (not just incremental) |
| `ft sync --folder [name]` | Sync a specific bookmark folder (interactive picker if omitted) |
| `ft sync --all` | Chain sync + classify + export in one command |
| `ft sync --api` | Sync via OAuth API (cross-platform) |
| `ft search <query>` | Full-text search with BM25 ranking |
| `ft list` | Filter by `--author`, `--category`, `--domain`, `--after`, `--before`, `--limit`, `--json` |
| `ft show <id>` | Show one bookmark in detail (`--no-thread` to suppress thread context) |
| `ft viz` | Terminal dashboard with sparklines, categories, and domains |
| `ft stats` | Top authors, languages, date range |
| `ft categories` | Show category distribution |
| `ft domains` | Subject domain distribution |
| `ft sample <category>` | Sample bookmarks by category |
| `ft classify` | Classify by category and domain using LLM |
| `ft classify --regex` | Classify by category using simple regex |
| `ft export` | Export bookmarks to Obsidian-compatible Markdown |
| `ft incomplete` | Show bookmarks with incomplete processing and why |
| `ft failures` | Show recent failure events with retryability hints |
| `ft retry [ids...]` | Retry incomplete bookmarks (`--all` to include terminal failures) |
| `ft hydrate` | Re-run incomplete bookmarks through the full pipeline |
| `ft refresh` | Reprocess bookmarks with incomplete core TweetDetail data |
| `ft threads` | Reprocess bookmarks with incomplete conversation threads |
| `ft fetch-media` | Reprocess bookmarks with missing media |
| `ft fetch-links` | Reprocess bookmarks with missing link content (`--github-only`) |
| `ft github-check` | Validate GitHub token, test API access, show precedence |
| `ft folders` | List X bookmark folders |
| `ft index` | Rebuild search index from cache (preserves classifications) |
| `ft auth` | Set up OAuth for API-based sync |
| `ft status` | Show sync status and data location |
| `ft path` | Print data directory path |

---

## Categories (regex + LLM)

| Category | What it catches |
|----------|----------------|
| **tool** | GitHub repos, CLI tools, npm packages, open-source projects |
| **security** | CVEs, vulnerabilities, exploits, supply chain |
| **technique** | Tutorials, demos, code patterns, "how I built X" |
| **launch** | Product launches, announcements, "just shipped" |
| **research** | ArXiv papers, studies, academic findings |
| **opinion** | Takes, analysis, commentary, threads |
| **commerce** | Products, shopping, physical goods |

LLM classification (`ft classify`) also assigns subject **domains** (ai, finance, security, healthcare, etc.) and catches what regex misses.

---

# Custom Additions (`jared_custom` branch)

Everything below was added in 5 commits on top of `main`.

---

## 1. Per-Bookmark Processing Pipeline

**File:** `src/bookmark-processor.ts` (~1470 lines)

The original batch processing was replaced with a sequential per-bookmark pipeline. Each bookmark goes through these steps before the next one starts:

```
discovery → core TweetDetail → thread fetch → media download → link fetch → complete
```

Key details:
- **Claim-based ownership** — 10-minute lease prevents duplicate processing across concurrent runs
- **Structured failure tracking** — every failure logged to `bookmark_failure_events` with step, error code, message, and retryability
- **Retryable vs terminal** — rate limits and transient errors auto-retry; 404s and forbidden responses are terminal
- **Resume-safe** — reruns pick up where they left off via `bookmark_processing` state table

### New CLI commands for pipeline management

| Command | What it does |
|---------|-------------|
| `ft incomplete` | Lists bookmarks stuck in processing with failure details |
| `ft failures` | Shows failure events with human-readable fix hints |
| `ft retry [ids...]` | Retries specific bookmarks or all retryable failures |
| `ft hydrate` | Re-runs incomplete bookmarks through the full pipeline |
| `ft refresh` | Reprocesses bookmarks missing core TweetDetail data |

### Database schema changes (v3 → v11)

New tables added to `bookmarks.db`:

| Table | Purpose |
|-------|---------|
| `bookmark_processing` | Per-bookmark state machine: status, retry count, claimed_at, next_retry_at |
| `bookmark_failure_events` | Structured failure log: step, code, message, retryable flag, timestamp |
| `bookmark_media_targets` | Per-bookmark media tracking: URL, type, local path, bytes, downloaded_at |
| `bookmark_link_targets` | Per-bookmark link tracking: URL, content type, status, attempted_at |

---

## 2. Database Migration: sql.js → better-sqlite3

**File:** `src/db.ts`

Swapped the in-memory WASM SQLite (`sql.js-fts5`) for native `better-sqlite3`. Same API surface, but now:
- Persistent on-disk database (no serialize/deserialize)
- Native prepared statements and transactions
- Better performance for large datasets
- Schema migrations run automatically on open

---

## 3. Thread Fetching

**File:** `src/graphql-threads.ts`

Fetches full conversation threads for bookmarked tweets using the TweetDetail GraphQL endpoint.

- Threads stored in `thread_tweets` table with position tracking (`threadPosition`, `isRoot`)
- FTS5 index (`thread_fts`) enables search across thread content
- `ft threads` command reprocesses bookmarks with incomplete thread data
- `ft show <id>` renders thread context inline (suppress with `--no-thread`)
- Thread tweets linked back to parent bookmark via `conversationId`

---

## 4. Link Content Fetching

**File:** `src/fetch-links.ts` (~425 lines)

Autonomously fetches content from URLs found in bookmarked tweets:

| URL type | How it's fetched |
|----------|-----------------|
| GitHub repo | API call for README content (raw markdown) |
| GitHub gist | API call for gist files |
| Articles | Content extraction |

- `ft fetch-links` command, with `--github-only` to skip non-GitHub links
- GitHub token resolved from multiple sources (env vars, `.env` files, config files)
- Rate limit awareness with structured failure codes (`github_rate_limited`, `github_forbidden`, etc.)
- Results stored in `bookmark_link_targets` table

---

## 5. Rich Obsidian Export

**File:** `src/export-markdown.ts` (~357 lines)

Exports bookmarks as Obsidian-compatible Markdown files with full metadata.

### Setup and usage

```bash
# Set your Obsidian vault path (persisted in DB)
ft export --set-output ~/Obsidian/Vault/bookmarks

# Export all unprocessed bookmarks
ft export

# Export with filters
ft export --category tool --after 2025-01-01 --limit 50

# Preview without writing
ft export --dry-run
```

### What each exported file contains

**YAML frontmatter:**
- `title`, `author`, `author_name`, `tweet_url`, `tweet_id`
- `posted_at`, `bookmarked_at`, `category`, `domain`
- `categories[]`, `domains[]`, `tags[]` (auto-tags: `x/bookmark`, `x/thread`)
- Engagement: `likes`, `reposts`, `replies`, `views`
- `has_thread`, `thread_length`, `media_count`, `has_media`
- `links[]`, `github_urls[]`
- `exported_at` timestamp

**Body:**
- Tweet text with `@handle` as H1
- Media embeds as Obsidian wikilinks: `![[assets/filename.ext]]`
- Engagement metadata line
- "View on X" link
- Link content in collapsible `<details>` sections
- Thread rendered as numbered subsections (`### 1/N — @handle`)

**Filename format:** `YYYY-MM-DD-handle-tweetid.md`

Media files copied to `assets/` subdirectory alongside the markdown files.

---

## 6. GraphQL Query ID Auto-Discovery

**File:** `src/graphql-query-ids.ts` (~313 lines)

X.com's GraphQL endpoints require operation-specific query IDs that change periodically. This system auto-discovers them:

1. Fetches `x.com` main page HTML
2. Extracts JS bundle URLs from `<script>` tags
3. Scans bundles for `queryId:"...",operationName:"..."` patterns
4. Discovers lazy-loaded webpack chunks for bookmark-related operations
5. Caches results at `~/.ft-bookmarks/graphql-query-ids.json` (24-hour TTL)

**Supported operations:** `Bookmarks`, `BookmarkFoldersSlice`, `BookmarkFolderTimeline`, `TweetDetail`

**Override via env vars:** `FT_BOOKMARKS_QUERY_ID`, `FT_BOOKMARK_FOLDERS_SLICE_QUERY_ID`, `FT_BOOKMARK_FOLDER_TIMELINE_QUERY_ID`, `FT_TWEET_DETAIL_QUERY_ID`

---

## 7. GitHub Token Validation

**File:** `src/github-check.ts` (~193 lines)

`ft github-check` inspects and validates the active GitHub token:

- Shows which token source won (process env, `.env` file, etc.)
- Tests authorization against GitHub API
- Reports available scopes and rate limit status
- Supports both `GITHUB_TOKEN` and `GITHUB_PERSONAL_ACCESS_TOKEN`
- `--json` flag for machine-readable output

---

## 8. Folder Sync

Sync bookmarks from a specific X bookmark folder instead of the full timeline:

```bash
# Interactive folder picker
ft sync --folder

# Sync by folder name
ft sync --folder "Process to Obsidian"

# List all folders
ft folders
```

Folder resolution accepts name, URL, or folder ID.

---

## 9. Pipeline Chaining (`--all`)

```bash
ft sync --all
```

Chains sync → classify → export in a single command. Useful for automated runs where you want the full pipeline.

---

## 10. Security Hardening

- **Removed `--full-auto`** — unsupervised LLM classification mode removed entirely
- **Prompt injection defenses** — `sanitizeBookmarkText()` filters patterns like "ignore previous instructions", "system:", "you are now"
- **Content isolation** — bookmark text wrapped in `<tweet_text>` delimiters with explicit security notes telling the LLM not to follow embedded instructions
- **Full text to LLM** — removed the 300-character truncation so classification sees the complete bookmark

---

# LaunchAgent Automation

A launchctl plist runs `ft sync --folder "Process to Obsidian"` every 5 minutes.

**Plist:** `~/Library/LaunchAgents/dev.fieldtheory-poller.plist`

```xml
<key>ProgramArguments</key>
<array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/jaredvogt/projects/fieldtheory-cli/dist/cli.js</string>
    <string>sync</string>
    <string>--folder</string>
    <string>Process to Obsidian</string>
</array>

<key>StartInterval</key>
<integer>300</integer>
```

**Logs:**
- stdout: `~/Library/Logs/fieldtheory-poller.log`
- stderr: `~/Library/Logs/fieldtheory-poller.err.log`

**Management:**

```bash
# Check status
launchctl print gui/$(id -u)/dev.fieldtheory-poller

# Unload
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.fieldtheory-poller.plist

# Reload
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.fieldtheory-poller.plist

# Run manually right now
launchctl kickstart gui/$(id -u)/dev.fieldtheory-poller
```

---

# Environment Variables

Resolution order (first match wins):

1. Process environment variables
2. `.env.local` in cwd
3. `.env` in cwd
4. `.env.local` in `~/.ft-bookmarks/`
5. `.env` in `~/.ft-bookmarks/`
6. `~/.env`

| Variable | Purpose |
|----------|---------|
| `FT_DATA_DIR` | Override data directory (default: `~/.ft-bookmarks/`) |
| `FT_CHROME_USER_DATA_DIR` | Chrome profile directory for session auth |
| `FT_CHROME_PROFILE_DIRECTORY` | Specific Chrome profile (default: `Default`) |
| `GITHUB_TOKEN` | GitHub API token for link content fetching |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Fallback GitHub token |
| `X_API_KEY` / `X_CONSUMER_KEY` | X API credentials (only for `--api` mode) |
| `X_API_SECRET` / `X_SECRET_KEY` | X API secret (only for `--api` mode) |
| `X_CLIENT_ID` | OAuth client ID (only for `--api` mode) |
| `X_CLIENT_SECRET` | OAuth client secret (only for `--api` mode) |
| `X_BEARER_TOKEN` | Optional bearer token override |
| `X_CALLBACK_URL` | OAuth callback URL (default: `http://127.0.0.1:3000/callback`) |
| `FT_BOOKMARKS_QUERY_ID` | Override GraphQL query ID for Bookmarks |
| `FT_BOOKMARK_FOLDERS_SLICE_QUERY_ID` | Override query ID for folder listing |
| `FT_BOOKMARK_FOLDER_TIMELINE_QUERY_ID` | Override query ID for folder timeline |
| `FT_TWEET_DETAIL_QUERY_ID` | Override query ID for TweetDetail |

---

# Data Directory

```
~/.ft-bookmarks/
  bookmarks.db                  # SQLite FTS5 search index (main database)
  bookmarks.jsonl               # Raw bookmark cache (one JSON per line)
  bookmarks-meta.json           # Sync metadata
  bookmarks-backfill-state.json # Backfill progress state
  thread-sync-state.json        # Thread sync tracking
  graphql-query-ids.json        # Cached GraphQL operation IDs (24h TTL)
  media-manifest.json           # Media download manifest
  media/                        # Downloaded images and videos
  oauth-token.json              # OAuth token (chmod 600, only for --api mode)
```

---

# Custom Files Index

Files added or significantly changed on `jared_custom`:

| File | Lines | What it does |
|------|-------|-------------|
| `src/bookmark-processor.ts` | ~1470 | Per-bookmark processing pipeline with claim/retry/failure tracking |
| `src/export-markdown.ts` | ~357 | Obsidian markdown export with frontmatter, media, threads, links |
| `src/fetch-links.ts` | ~425 | GitHub README/gist and article content fetching |
| `src/graphql-threads.ts` | ~193 | Thread conversation fetching via TweetDetail GraphQL |
| `src/graphql-query-ids.ts` | ~313 | Auto-discovery and caching of X.com GraphQL query IDs |
| `src/github-check.ts` | ~193 | GitHub token validation and inspection |
| `src/bookmarks-db.ts` | +1400 | Schema v3→v11, pipeline tables, failure events, thread/link storage |
| `src/cli.ts` | +616 | New commands, folder sync, progress rendering, failure hints |
| `src/db.ts` | +130 | sql.js → better-sqlite3 migration |
| `src/config.ts` | +86 | Multi-source env resolution (`resolveEnvBindings()`) |
| `src/bookmark-classify-llm.ts` | +22 | Prompt injection defenses, removed truncation |
| `tests/bookmark-processor.test.ts` | ~416 | Pipeline tests |
| `tests/fetch-links.test.ts` | ~82 | Link fetching tests |
| `tests/github-check.test.ts` | ~103 | GitHub token tests |

---

# Platform Support

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Chrome session sync (`ft sync`) | Yes | No | No |
| OAuth API sync (`ft sync --api`) | Yes | Yes | Yes |
| Search, list, classify, viz | Yes | Yes | Yes |
| LaunchAgent automation | Yes | No (use cron) | No |

---

# Build & Dev

```bash
npm run build     # Compile TypeScript to dist/
npm run dev       # Run via tsx directly
npm run test      # Run tests
npm run start     # Run compiled dist/cli.js
```

License: MIT
