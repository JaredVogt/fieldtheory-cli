# znote

A running log of bugs, ideas, and notes captured during development.

---

## #1 Enable translation for non-English tweet bookmarks

**Date:** 2026-04-17
**Status:** open
**Tags:** `note`

### Current state

- Tweet text is stored in its original language. Example: Brivael's French LIDAR tweet is stored as `language='fr'` with text beginning `"Aujourd'hui grosse discussion avec mes ingés..."`.
- X's GraphQL API always returns the original-language text. The "Translated from French" label on x.com is a **client-side Google Translate overlay** — it's not part of the tweet payload the API returns.
- Grep confirms there is no translation code anywhere in `src/`.

### Why this matters

Quoted tweets (now captured via `ingested_via='quoted'`) and regular bookmarks in non-English languages remain opaque to English search, classification, and export. Brivael's substantive LIDAR analysis is useless to English-first workflows until translated.

### Options for enabling translation

**Option A — Translate at ingest time (new column)**
- Add `text_translated TEXT` and `text_translated_lang TEXT` columns to `bookmarks` (and optionally `thread_tweets`).
- During the processing pipeline (alongside classification), if `language != 'en'`, call an LLM or translation API and store the English version.
- Pros: one-time cost per tweet; translated text is indexable by FTS; export is instant.
- Cons: schema change; migration for existing 3900+ tweets; cost at scale; invalidation if we want to re-translate.

**Option B — Translate at export time only**
- Keep DB pristine with originals.
- In `export-markdown.ts`, detect `language != 'en'` and call translation API to produce a translated block alongside the original in the exported Markdown.
- Pros: no schema change; translations are cacheable per-export; easy to toggle on/off via a flag.
- Cons: search/classify still operate on original language; repeated cost if exporting multiple times (mitigated with a translation cache file).

**Option C — Hybrid**
- Cache translations in a standalone `translations` table keyed by `tweet_id` (avoids schema churn on `bookmarks`).
- Populated lazily on first request (export, search-with-translation flag, etc.).
- Pros: separates concerns, incremental adoption, no forced migration.
- Cons: extra join for consumers that want translated text.

### Implementation notes (whichever path)

- Translation backend: LLM (Claude/GPT) is overkill for straightforward tweet prose; Google Translate / DeepL API is cheaper and faster. LLMs are only worth it if we want context-aware handling of handles, slang, and technical terms.
- Respect `language='und'` (undetermined) — skip translation, don't guess.
- Short tweets (< ~5 words) often aren't worth translating — skip with a threshold.
- Store `translated_by` (model/service name) and `translated_at` for future re-translation.

### Suggested next step

Option C (hybrid cache table) is probably the cleanest: no schema migration on the hot `bookmarks` table, and it cleanly supports both ingest-time eager translation and export-time lazy translation later.

---
