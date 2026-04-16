# Field Theory CLI

Sync and store locally all of your X/Twitter bookmarks. Search, classify, and make them available to Claude Code, Codex, or any agent with shell access.

Free and open source. Designed for Mac.

## Install

```bash
npm install -g fieldtheory
```

Requires Node.js 20+ and Google Chrome.

## Quick start

```bash
# 1. Sync your bookmarks end-to-end (needs Chrome logged into X)
ft sync

# 2. Search them
ft search "distributed systems"

# 3. Explore
ft viz
ft categories
ft stats
```

On first run, `ft sync` extracts your X session from Chrome and processes bookmarks one at a time into `~/.ft-bookmarks/`. Each bookmark is fetched all the way through before the sync moves on, so reruns can resume incomplete items safely.

## Commands

| Command | Description |
|---------|-------------|
| `ft sync` | Discover and fully process bookmarks one at a time (tweet, thread, media, links) |
| `ft sync --classify` | Sync then classify new bookmarks with LLM |
| `ft sync --full` | Full history crawl (not just incremental) |
| `ft incomplete` | Show bookmarks that are still incomplete and why |
| `ft retry [ids...]` | Retry incomplete bookmarks (`--all` includes terminal, `--verbose` for per-bookmark output) |
| `ft hydrate` | Re-run incomplete bookmarks through the direct pipeline |
| `ft refresh` | Reprocess bookmarks with incomplete core TweetDetail data |
| `ft threads` | Reprocess bookmarks with incomplete conversation threads |
| `ft fetch-media` | Reprocess bookmarks with missing thread media |
| `ft fetch-links` | Reprocess bookmarks with missing fetched link content |
| `ft failures` | Show recent failure events and likely fixes |
| `ft github-check` | Show which GitHub token is active and validate it against GitHub |
| `ft search <query>` | Full-text search with BM25 ranking |
| `ft viz` | Terminal dashboard with sparklines, categories, and domains |
| `ft classify` | Classify by category and domain using LLM |
| `ft classify --regex` | Classify by category using simple regex |
| `ft categories` | Show category distribution |
| `ft domains` | Subject domain distribution |
| `ft stats` | Top authors, languages, date range |
| `ft list` | Filter by author, date, category, domain |
| `ft show <id>` | Show one bookmark in detail |
| `ft index` | Merge new bookmarks into search index (preserves classifications) |
| `ft auth` | Set up OAuth for API-based sync (optional) |
| `ft sync --api` | Sync via OAuth API (cross-platform) |
| `ft status` | Show sync status and data location |
| `ft path` | Print data directory path |

## Agent integration

Now you can ask your agent:

> "What have I bookmarked about cancer research in the last three years and how has it progressed?"

> "I bookmarked a number of new open source AI memory tools. Pick the best one and figure out how to incorporate it in this repo."

> "Every day please sync any new X bookmarks using the Field Theory CLI."

Works with Claude Code, Codex, or any agent with shell access. Just tell your agent to use the `ft` CLI.

## Scheduling

```bash
# Sync every morning at 7am
0 7 * * * ft sync

# Sync and classify every morning
0 7 * * * ft sync --classify
```

## Data

All data is stored locally at `~/.ft-bookmarks/`:

```
~/.ft-bookmarks/
  bookmarks.jsonl         # raw bookmark cache (one per line)
  bookmarks.db            # SQLite FTS5 search index
  bookmarks-meta.json     # sync metadata
  oauth-token.json        # OAuth token (if using API mode, chmod 600)
```

Override the location with `FT_DATA_DIR`:

```bash
export FT_DATA_DIR=/path/to/custom/dir
```

To remove all data: `rm -rf ~/.ft-bookmarks`

## Link content extraction

During sync, links found in bookmarks and their threads are fetched and stored for full-text search. The following content types are supported:

| Source | What gets extracted |
|--------|---------------------|
| **GitHub repos** | README content via API (falls back to `raw.githubusercontent.com`) |
| **GitHub Gists** | All gist files via API (falls back to raw URL if API returns 5xx) |
| **PDFs** | Full text extracted from PDF documents (up to 20 MB) |
| **HTML articles** | Readable text extracted from web pages |
| **Plain text / JSON** | Raw content stored directly |

Links that can't be parsed (JS-rendered SPAs, paywalled sites, non-text content like images) are marked as terminal incomplete. Use `ft incomplete` to see which bookmarks have unresolved links and `ft failures` for detailed error info.

Set `GITHUB_TOKEN` or `GITHUB_PERSONAL_ACCESS_TOKEN` in `~/.env` to authenticate GitHub API requests and avoid 401/403 errors on private repos and gists.

## Categories

| Category | What it catches |
|----------|----------------|
| **tool** | GitHub repos, CLI tools, npm packages, open-source projects |
| **security** | CVEs, vulnerabilities, exploits, supply chain |
| **technique** | Tutorials, demos, code patterns, "how I built X" |
| **launch** | Product launches, announcements, "just shipped" |
| **research** | ArXiv papers, studies, academic findings |
| **opinion** | Takes, analysis, commentary, threads |
| **commerce** | Products, shopping, physical goods |

Use `ft classify` for LLM-powered classification that catches what regex misses.

## Platform support

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Chrome session sync (`ft sync`) | Yes | No* | No* |
| OAuth API sync (`ft sync --api`) | Yes | Yes | Yes |
| Search, list, classify, viz | Yes | Yes | Yes |

\*Chrome session extraction uses macOS Keychain. On other platforms, use `ft auth` + `ft sync --api`.

## Security

**Your data stays local.** No telemetry, no analytics, nothing phoned home. The CLI only makes network requests to X's API during sync.

**Chrome session sync** reads cookies from Chrome's local database, uses them for the sync request, and discards them. Cookies are never stored separately.

**OAuth tokens** are stored with `chmod 600` (owner-only). Treat `~/.ft-bookmarks/oauth-token.json` like a password.

**The default sync uses X's internal GraphQL API**, the same API that x.com uses in your browser. For the official v2 API, use `ft auth` + `ft sync --api`.

## License

MIT — [fieldtheory.dev/cli](https://fieldtheory.dev/cli)
