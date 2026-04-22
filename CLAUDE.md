# CLAUDE.md

This is the Field Theory CLI — a standalone tool for syncing and querying X/Twitter bookmarks locally.

## Commands

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Run via tsx directly
npm run test         # Run tests
npm run start        # Run compiled dist/cli.js
```

## Architecture

Single CLI application built with Commander.js. All data stored in `~/.ft-bookmarks/`.

### Key files

| File | Purpose |
|------|---------|
| `src/cli.ts` | Command definitions, progress bar, first-run UX |
| `src/paths.ts` | Data directory resolution (`~/.ft-bookmarks/`) |
| `src/graphql-bookmarks.ts` | GraphQL sync engine (Chrome session cookies), folder sync |
| `src/graphql-threads.ts` | Thread fetching via TweetDetail GraphQL |
| `src/graphql-articles.ts` | X native article fetching via TweetResultByRestId; reconstructs full body from `content_state` blocks + `entityMap` |
| `src/bookmarks.ts` | OAuth API sync |
| `src/bookmarks-db.ts` | SQLite FTS5 index, search, list, stats, thread + article storage |
| `src/bookmark-classify.ts` | Regex-based category classifier |
| `src/bookmark-classify-llm.ts` | Optional LLM classifier |
| `src/bookmarks-viz.ts` | ANSI terminal dashboard |
| `src/chrome-cookies.ts` | Chrome cookie extraction (macOS Keychain) |
| `src/xauth.ts` | OAuth 2.0 flow |
| `src/db.ts` | WASM SQLite layer (sql.js-fts5) |

### Data flow

```
Chrome cookies → GraphQL API → JSONL cache → SQLite FTS5 index
                     ↓                            ↓
              TweetDetail API            thread_tweets table + FTS
                     ↓                            ↓
              TweetResultByRestId       article_* columns on bookmarks
              (focal+quoted articles)    (article_title + article_text in FTS)
                     ↓                            ↓
              Folder timeline API        Search UNION (bookmarks + threads + articles inline)
                                                  ↓
                                    Regex classification → Search / List / Viz / Obsidian export
```

X native articles (`x.com/.../article/...`) are fetched inline during `processBookmark` for focal and quoted tweets — replies are skipped. `ft articles --force` re-fetches existing rows after extractor changes.

### Dependencies

All pure JavaScript/WASM — no native bindings:
- `commander` — CLI framework
- `sql.js` + `sql.js-fts5` — SQLite in WebAssembly
- `zod` — schema validation
- `dotenv` — .env file loading
