import type { Database } from './db.js';
import { openDb, saveDb } from './db.js';
import { readJsonLines, readJson, writeJson, pathExists } from './fs.js';
import { twitterBookmarksCachePath, twitterBookmarksIndexPath, twitterBookmarksMetaPath } from './paths.js';
import type { BookmarkRecord, ThreadTweetRecord } from './types.js';
import { classifyCorpus, formatClassificationSummary } from './bookmark-classify.js';
import type { ClassificationSummary } from './bookmark-classify.js';

const SCHEMA_VERSION = 11;

export interface SearchResult {
  id: string;
  url: string;
  text: string;
  authorHandle?: string;
  authorName?: string;
  postedAt?: string | null;
  score: number;
  source?: 'bookmark' | 'thread' | 'link';
  threadMatchText?: string;
  threadMatchAuthor?: string;
  linkMatchTitle?: string;
  linkMatchUrl?: string;
}

export interface SearchOptions {
  query: string;
  author?: string;
  limit?: number;
  before?: string;
  after?: string;
}

export interface BookmarkTimelineItem {
  id: string;
  tweetId: string;
  url: string;
  text: string;
  authorHandle?: string;
  authorName?: string;
  authorProfileImageUrl?: string;
  postedAt?: string | null;
  bookmarkedAt?: string | null;
  categories: string[];
  primaryCategory?: string | null;
  domains: string[];
  primaryDomain?: string | null;
  githubUrls: string[];
  links: string[];
  mediaCount: number;
  linkCount: number;
  likeCount?: number | null;
  repostCount?: number | null;
  replyCount?: number | null;
  quoteCount?: number | null;
  bookmarkCount?: number | null;
  viewCount?: number | null;
}

export interface BookmarkTimelineFilters {
  query?: string;
  author?: string;
  after?: string;
  before?: string;
  category?: string;
  domain?: string;
  sort?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export type BookmarkProcessingState =
  | 'pending'
  | 'in_progress'
  | 'retryable_failed'
  | 'terminal_incomplete'
  | 'complete';

export type BookmarkStepStatus =
  | 'pending'
  | 'in_progress'
  | 'complete'
  | 'incomplete';

export interface BookmarkProcessingRow {
  bookmarkId: string;
  processingState: BookmarkProcessingState;
  coreStatus: BookmarkStepStatus;
  threadStatus: BookmarkStepStatus;
  mediaStatus: BookmarkStepStatus;
  linksStatus: BookmarkStepStatus;
  attemptCount: number;
  lastErrorStep?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  nextRetryAt?: string | null;
  claimedAt?: string | null;
  claimOwner?: string | null;
  completedAt?: string | null;
  requiresRevalidation: boolean;
  updatedAt: string;
}

export interface IncompleteBookmarkItem extends BookmarkTimelineItem {
  processingState: BookmarkProcessingState;
  coreStatus: BookmarkStepStatus;
  threadStatus: BookmarkStepStatus;
  mediaStatus: BookmarkStepStatus;
  linksStatus: BookmarkStepStatus;
  attemptCount: number;
  lastErrorStep?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  completedAt?: string | null;
  nextRetryAt?: string | null;
}

export interface BookmarkFailureEventRow {
  id: string;
  bookmarkId: string;
  step: string;
  targetKind: string;
  targetRef?: string | null;
  failureCode: string;
  failureMessage: string;
  retryable: boolean;
  processingState?: string | null;
  occurredAt: string;
}

export interface FailureEventItem extends BookmarkFailureEventRow {
  url: string;
  text: string;
  authorHandle?: string;
  authorName?: string;
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseCsv(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mapTimelineRow(row: unknown[]): BookmarkTimelineItem {
  return {
    id: row[0] as string,
    tweetId: row[1] as string,
    url: row[2] as string,
    text: row[3] as string,
    authorHandle: (row[4] as string) ?? undefined,
    authorName: (row[5] as string) ?? undefined,
    authorProfileImageUrl: (row[6] as string) ?? undefined,
    postedAt: (row[7] as string) ?? null,
    bookmarkedAt: (row[8] as string) ?? null,
    categories: parseCsv(row[9]),
    primaryCategory: (row[10] as string) ?? null,
    domains: parseCsv(row[11]),
    primaryDomain: (row[12] as string) ?? null,
    githubUrls: parseJsonArray(row[13]),
    links: parseJsonArray(row[14]),
    mediaCount: Number(row[15] ?? 0),
    linkCount: Number(row[16] ?? 0),
    likeCount: row[17] as number | null,
    repostCount: row[18] as number | null,
    replyCount: row[19] as number | null,
    quoteCount: row[20] as number | null,
    bookmarkCount: row[21] as number | null,
    viewCount: row[22] as number | null,
  };
}

function buildBookmarkWhereClause(filters: BookmarkTimelineFilters): {
  where: string;
  params: Array<string | number>;
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filters.query) {
    conditions.push(`b.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ?)`);
    params.push(filters.query);
  }
  if (filters.author) {
    conditions.push(`b.author_handle = ? COLLATE NOCASE`);
    params.push(filters.author);
  }
  if (filters.after) {
    conditions.push(`COALESCE(b.posted_at, b.bookmarked_at) >= ?`);
    params.push(filters.after);
  }
  if (filters.before) {
    conditions.push(`COALESCE(b.posted_at, b.bookmarked_at) <= ?`);
    params.push(filters.before);
  }
  if (filters.category) {
    conditions.push(`b.categories LIKE ?`);
    params.push(`%${filters.category}%`);
  }
  if (filters.domain) {
    conditions.push(`b.domains LIKE ?`);
    params.push(`%${filters.domain}%`);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function bookmarkSortClause(direction: 'asc' | 'desc' = 'desc'): string {
  const normalized = direction === 'asc' ? 'ASC' : 'DESC';
  return `
    ORDER BY
      CASE
        WHEN b.bookmarked_at GLOB '____-__-__*' THEN b.bookmarked_at
        WHEN b.posted_at GLOB '____-__-__*' THEN b.posted_at
        ELSE ''
      END ${normalized},
      CAST(b.tweet_id AS INTEGER) ${normalized}
  `;
}

function ensureFailureEventSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS bookmark_failure_events (
    id TEXT PRIMARY KEY,
    bookmark_id TEXT NOT NULL,
    step TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_ref TEXT,
    failure_code TEXT NOT NULL,
    failure_message TEXT NOT NULL,
    retryable INTEGER NOT NULL DEFAULT 0,
    processing_state TEXT,
    occurred_at TEXT NOT NULL,
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_failure_events_bookmark ON bookmark_failure_events(bookmark_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_failure_events_occurred ON bookmark_failure_events(occurred_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_failure_events_code ON bookmark_failure_events(failure_code)`);
}

function initSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

  db.run(`CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    tweet_id TEXT NOT NULL,
    url TEXT NOT NULL,
    text TEXT NOT NULL,
    author_handle TEXT,
    author_name TEXT,
    author_profile_image_url TEXT,
    posted_at TEXT,
    bookmarked_at TEXT,
    synced_at TEXT NOT NULL,
    conversation_id TEXT,
    in_reply_to_status_id TEXT,
    quoted_status_id TEXT,
    language TEXT,
    like_count INTEGER,
    repost_count INTEGER,
    reply_count INTEGER,
    quote_count INTEGER,
    bookmark_count INTEGER,
    view_count INTEGER,
    media_count INTEGER DEFAULT 0,
    media_json TEXT,
    link_count INTEGER DEFAULT 0,
    links_json TEXT,
    tags_json TEXT,
    ingested_via TEXT,
    categories TEXT,
    primary_category TEXT,
    github_urls TEXT,
    domains TEXT,
    primary_domain TEXT,
    thread_fetched INTEGER DEFAULT 0,
    text_refreshed INTEGER DEFAULT 0,
    hydrated INTEGER DEFAULT 0,
    exported_at TEXT
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_bookmarks_author ON bookmarks(author_handle)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookmarks_posted ON bookmarks(posted_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookmarks_language ON bookmarks(language)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookmarks_category ON bookmarks(primary_category)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookmarks_domain ON bookmarks(primary_domain)`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
    text,
    author_handle,
    author_name,
    content=bookmarks,
    content_rowid=rowid,
    tokenize='porter unicode61'
  )`);
  db.run(`CREATE TRIGGER IF NOT EXISTS bookmarks_ai AFTER INSERT ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(rowid, text, author_handle, author_name)
    VALUES (new.rowid, new.text, new.author_handle, new.author_name);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS bookmarks_ad AFTER DELETE ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(bookmarks_fts, rowid, text, author_handle, author_name)
    VALUES ('delete', old.rowid, old.text, old.author_handle, old.author_name);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS bookmarks_au AFTER UPDATE ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(bookmarks_fts, rowid, text, author_handle, author_name)
    VALUES ('delete', old.rowid, old.text, old.author_handle, old.author_name);
    INSERT INTO bookmarks_fts(rowid, text, author_handle, author_name)
    VALUES (new.rowid, new.text, new.author_handle, new.author_name);
  END`);

  // ── Thread tables ───────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS thread_tweets (
    id TEXT PRIMARY KEY,
    tweet_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    url TEXT NOT NULL,
    text TEXT NOT NULL,
    author_handle TEXT,
    author_name TEXT,
    author_profile_image_url TEXT,
    posted_at TEXT,
    synced_at TEXT NOT NULL,
    in_reply_to_status_id TEXT,
    parent_tweet_id TEXT,
    thread_position INTEGER NOT NULL,
    is_root INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    like_count INTEGER,
    repost_count INTEGER,
    reply_count INTEGER,
    view_count INTEGER,
    media_count INTEGER DEFAULT 0,
    media_json TEXT,
    link_count INTEGER DEFAULT 0,
    links_json TEXT
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_thread_conversation ON thread_tweets(conversation_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_thread_position ON thread_tweets(conversation_id, thread_position)`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS thread_fts USING fts5(
    text,
    author_handle,
    author_name,
    content=thread_tweets,
    content_rowid=rowid,
    tokenize='porter unicode61'
  )`);
  db.run(`CREATE TRIGGER IF NOT EXISTS thread_tweets_ai AFTER INSERT ON thread_tweets BEGIN
    INSERT INTO thread_fts(rowid, text, author_handle, author_name)
    VALUES (new.rowid, new.text, new.author_handle, new.author_name);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS thread_tweets_ad AFTER DELETE ON thread_tweets BEGIN
    INSERT INTO thread_fts(thread_fts, rowid, text, author_handle, author_name)
    VALUES ('delete', old.rowid, old.text, old.author_handle, old.author_name);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS thread_tweets_au AFTER UPDATE ON thread_tweets BEGIN
    INSERT INTO thread_fts(thread_fts, rowid, text, author_handle, author_name)
    VALUES ('delete', old.rowid, old.text, old.author_handle, old.author_name);
    INSERT INTO thread_fts(rowid, text, author_handle, author_name)
    VALUES (new.rowid, new.text, new.author_handle, new.author_name);
  END`);

  db.run(`CREATE TABLE IF NOT EXISTS bookmark_processing (
    bookmark_id TEXT PRIMARY KEY,
    processing_state TEXT NOT NULL DEFAULT 'pending',
    core_status TEXT NOT NULL DEFAULT 'pending',
    thread_status TEXT NOT NULL DEFAULT 'pending',
    media_status TEXT NOT NULL DEFAULT 'pending',
    links_status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_step TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    next_retry_at TEXT,
    claimed_at TEXT,
    claim_owner TEXT,
    completed_at TEXT,
    requires_revalidation INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bookmark_media_targets (
    id TEXT PRIMARY KEY,
    bookmark_id TEXT NOT NULL,
    tweet_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    content_type TEXT,
    local_path TEXT,
    bytes INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TEXT,
    downloaded_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
    UNIQUE (bookmark_id, source_url)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_media_targets_bookmark ON bookmark_media_targets(bookmark_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_media_targets_status ON bookmark_media_targets(status)`);

  db.run(`CREATE TABLE IF NOT EXISTS bookmark_link_targets (
    id TEXT PRIMARY KEY,
    bookmark_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    resolved_url TEXT,
    content_type TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TEXT,
    fetched_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
    UNIQUE (bookmark_id, source_url)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_link_targets_bookmark ON bookmark_link_targets(bookmark_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_link_targets_status ON bookmark_link_targets(status)`);

  db.run(`CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  ensureFailureEventSchema(db);

  db.run(`REPLACE INTO meta VALUES ('schema_version', '${SCHEMA_VERSION}')`);
}

export function ensureDbSchema(db: Database): void {
  // Ensure meta table exists (may not on a fresh/empty DB)
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const rows = db.exec("SELECT value FROM meta WHERE key = 'schema_version'");
  const version = rows.length ? Number(rows[0].values[0]?.[0] ?? 0) : 0;
  if (version < 3) {
    // bookmarks table may not exist yet (first run before index build)
    const tableExists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='bookmarks'");
    if (tableExists.length && tableExists[0].values.length > 0) {
      try { db.run('ALTER TABLE bookmarks ADD COLUMN domains TEXT'); } catch { /* already exists */ }
      try { db.run('ALTER TABLE bookmarks ADD COLUMN primary_domain TEXT'); } catch { /* already exists */ }
      db.run('CREATE INDEX IF NOT EXISTS idx_bookmarks_domain ON bookmarks(primary_domain)');
    }
    db.run("REPLACE INTO meta VALUES ('schema_version', '3')");
  }
  if (version < 4) {
    const tableExists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='bookmarks'");
    if (tableExists.length && tableExists[0].values.length > 0) {
      try { db.run('ALTER TABLE bookmarks ADD COLUMN thread_fetched INTEGER DEFAULT 0'); } catch { /* already exists */ }
    }
    // thread_tweets + thread_fts are created by initSchema which runs before migrations
    db.run("REPLACE INTO meta VALUES ('schema_version', '4')");
  }
  if (version < 5) {
    const tableExists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='bookmarks'");
    if (tableExists.length && tableExists[0].values.length > 0) {
      try { db.run('ALTER TABLE bookmarks ADD COLUMN exported_at TEXT'); } catch { /* already exists */ }
    }
    db.run("REPLACE INTO meta VALUES ('schema_version', '5')");
  }
  if (version < 6) {
    // link_content table + FTS created by ensureLinkContentSchema (called on demand)
    // Just bump the version — the table is created lazily by fetch-links
    db.run("REPLACE INTO meta VALUES ('schema_version', '6')");
  }
  if (version < 7) {
    const tableExists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='bookmarks'");
    if (tableExists.length && tableExists[0].values.length > 0) {
      try { db.run('ALTER TABLE bookmarks ADD COLUMN text_refreshed INTEGER DEFAULT 0'); } catch { /* already exists */ }
    }
    db.run("REPLACE INTO meta VALUES ('schema_version', '7')");
  }
  if (version < 8) {
    const tableExists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='bookmarks'");
    if (tableExists.length && tableExists[0].values.length > 0) {
      try { db.run('ALTER TABLE bookmarks ADD COLUMN hydrated INTEGER DEFAULT 0'); } catch { /* already exists */ }
    }
    db.run("REPLACE INTO meta VALUES ('schema_version', '8')");
  }
  if (version < 9) {
    const bookmarkTableExists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='bookmarks'");
    if (bookmarkTableExists.length && bookmarkTableExists[0].values.length > 0) {
      try { db.run('ALTER TABLE bookmarks ADD COLUMN media_json TEXT'); } catch { /* already exists */ }
    }
    const threadTableExists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_tweets'");
    if (threadTableExists.length && threadTableExists[0].values.length > 0) {
      try { db.run('ALTER TABLE thread_tweets ADD COLUMN media_json TEXT'); } catch { /* already exists */ }
    }
    initSchema(db);
    db.run("REPLACE INTO meta VALUES ('schema_version', '9')");
  }
  if (version < 10) {
    initSchema(db);
    db.run("REPLACE INTO meta VALUES ('schema_version', '10')");
  }
  if (version < 11) {
    ensureFailureEventSchema(db);
    db.run("REPLACE INTO meta VALUES ('schema_version', '11')");
  }
}

function jsonText(value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return JSON.stringify(value);
}

function sameNullable(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

export function ensureBookmarkProcessingRow(db: Database, bookmarkId: string): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO bookmark_processing (
      bookmark_id, processing_state, core_status, thread_status, media_status, links_status,
      attempt_count, requires_revalidation, updated_at
    ) VALUES (?, 'pending', 'pending', 'pending', 'pending', 'pending', 0, 1, ?)`,
    [bookmarkId, now],
  );
}

export function markBookmarkPendingValidation(db: Database, bookmarkId: string, reason?: string): void {
  const now = new Date().toISOString();
  ensureBookmarkProcessingRow(db, bookmarkId);
  db.run(
    `UPDATE bookmark_processing
     SET processing_state = 'pending',
         core_status = 'pending',
         thread_status = 'pending',
         media_status = 'pending',
         links_status = 'pending',
         last_error_step = ?,
         last_error_code = NULL,
         last_error_message = NULL,
         next_retry_at = NULL,
         completed_at = NULL,
         requires_revalidation = 1,
         updated_at = ?
     WHERE bookmark_id = ?`,
    [reason ?? null, now, bookmarkId],
  );
}

export function upsertBookmarkRecord(
  db: Database,
  r: BookmarkRecord,
  options: { markPendingOnChange?: boolean } = {},
): { inserted: boolean; changed: boolean } {
  // Extract GitHub URLs (kept inline — no LLM needed for URL parsing)
  const text = r.text ?? '';
  const githubMatches = text.match(/github\.com\/[\w.-]+\/[\w.-]+/gi) ?? [];
  const githubFromLinks = (r.links ?? []).filter((l) => /github\.com/i.test(l));
  const githubUrls = [...new Set([...githubMatches.map((m) => `https://${m}`), ...githubFromLinks])];
  const mediaJson = jsonText(r.media ?? []);
  const linksJson = jsonText(r.links ?? []);
  const tagsJson = jsonText(r.tags ?? []);
  const githubJson = jsonText(githubUrls);

  const existingRow = db.exec(
    `SELECT tweet_id, url, text, author_handle, author_name, author_profile_image_url,
            posted_at, bookmarked_at, synced_at, conversation_id, in_reply_to_status_id,
            quoted_status_id, language, like_count, repost_count, reply_count, quote_count,
            bookmark_count, view_count, media_count, media_json, link_count, links_json,
            tags_json, ingested_via, github_urls
     FROM bookmarks WHERE id = ?`,
    [r.id],
  )[0]?.values?.[0];

  // Don't demote a first-class bookmark ('graphql' | 'api' | 'browser') to 'quoted'
  // just because it also appears as a quoted tweet elsewhere.
  const existingIngestedVia = existingRow?.[24] as string | null | undefined;
  const effectiveIngestedVia =
    r.ingestedVia === 'quoted' &&
    existingIngestedVia &&
    existingIngestedVia !== 'quoted'
      ? existingIngestedVia
      : r.ingestedVia ?? null;

  const incomingValues = {
    tweetId: r.tweetId,
    url: r.url,
    text: r.text,
    authorHandle: r.authorHandle ?? null,
    authorName: r.authorName ?? null,
    authorProfileImageUrl: r.authorProfileImageUrl ?? null,
    postedAt: r.postedAt ?? null,
    bookmarkedAt: r.bookmarkedAt ?? null,
    syncedAt: r.syncedAt,
    conversationId: r.conversationId ?? null,
    inReplyToStatusId: r.inReplyToStatusId ?? null,
    quotedStatusId: r.quotedStatusId ?? null,
    language: r.language ?? null,
    likeCount: r.engagement?.likeCount ?? null,
    repostCount: r.engagement?.repostCount ?? null,
    replyCount: r.engagement?.replyCount ?? null,
    quoteCount: r.engagement?.quoteCount ?? null,
    bookmarkCount: r.engagement?.bookmarkCount ?? null,
    viewCount: r.engagement?.viewCount ?? null,
    mediaCount: r.media?.length ?? 0,
    mediaJson,
    linkCount: r.links?.length ?? 0,
    linksJson,
    tagsJson,
    ingestedVia: effectiveIngestedVia,
    githubJson,
  };

  if (!existingRow) {
    db.run(
      `INSERT INTO bookmarks (
        id, tweet_id, url, text, author_handle, author_name, author_profile_image_url,
        posted_at, bookmarked_at, synced_at, conversation_id, in_reply_to_status_id,
        quoted_status_id, language, like_count, repost_count, reply_count, quote_count,
        bookmark_count, view_count, media_count, media_json, link_count, links_json, tags_json,
        ingested_via, categories, primary_category, github_urls, domains, primary_domain,
        thread_fetched, text_refreshed, hydrated, exported_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        r.id,
        incomingValues.tweetId,
        incomingValues.url,
        incomingValues.text,
        incomingValues.authorHandle,
        incomingValues.authorName,
        incomingValues.authorProfileImageUrl,
        incomingValues.postedAt,
        incomingValues.bookmarkedAt,
        incomingValues.syncedAt,
        incomingValues.conversationId,
        incomingValues.inReplyToStatusId,
        incomingValues.quotedStatusId,
        incomingValues.language,
        incomingValues.likeCount,
        incomingValues.repostCount,
        incomingValues.replyCount,
        incomingValues.quoteCount,
        incomingValues.bookmarkCount,
        incomingValues.viewCount,
        incomingValues.mediaCount,
        incomingValues.mediaJson,
        incomingValues.linkCount,
        incomingValues.linksJson,
        incomingValues.tagsJson,
        incomingValues.ingestedVia,
        null,
        'unclassified',
        incomingValues.githubJson,
        null,
        null,
        0,
        0,
        0,
        null,
      ],
    );
    ensureBookmarkProcessingRow(db, r.id);
    return { inserted: true, changed: true };
  }

  const changed =
    !sameNullable(existingRow[0], incomingValues.tweetId) ||
    !sameNullable(existingRow[1], incomingValues.url) ||
    !sameNullable(existingRow[2], incomingValues.text) ||
    !sameNullable(existingRow[3], incomingValues.authorHandle) ||
    !sameNullable(existingRow[4], incomingValues.authorName) ||
    !sameNullable(existingRow[5], incomingValues.authorProfileImageUrl) ||
    !sameNullable(existingRow[6], incomingValues.postedAt) ||
    !sameNullable(existingRow[7], incomingValues.bookmarkedAt) ||
    !sameNullable(existingRow[8], incomingValues.syncedAt) ||
    !sameNullable(existingRow[9], incomingValues.conversationId) ||
    !sameNullable(existingRow[10], incomingValues.inReplyToStatusId) ||
    !sameNullable(existingRow[11], incomingValues.quotedStatusId) ||
    !sameNullable(existingRow[12], incomingValues.language) ||
    !sameNullable(existingRow[13], incomingValues.likeCount) ||
    !sameNullable(existingRow[14], incomingValues.repostCount) ||
    !sameNullable(existingRow[15], incomingValues.replyCount) ||
    !sameNullable(existingRow[16], incomingValues.quoteCount) ||
    !sameNullable(existingRow[17], incomingValues.bookmarkCount) ||
    !sameNullable(existingRow[18], incomingValues.viewCount) ||
    !sameNullable(existingRow[19], incomingValues.mediaCount) ||
    !sameNullable(existingRow[20], incomingValues.mediaJson) ||
    !sameNullable(existingRow[21], incomingValues.linkCount) ||
    !sameNullable(existingRow[22], incomingValues.linksJson) ||
    !sameNullable(existingRow[23], incomingValues.tagsJson) ||
    !sameNullable(existingRow[24], incomingValues.ingestedVia) ||
    !sameNullable(existingRow[25], incomingValues.githubJson);

  db.run(
    `UPDATE bookmarks
     SET tweet_id = ?, url = ?, text = ?, author_handle = ?, author_name = ?, author_profile_image_url = ?,
         posted_at = ?, bookmarked_at = ?, synced_at = ?, conversation_id = ?, in_reply_to_status_id = ?,
         quoted_status_id = ?, language = ?, like_count = ?, repost_count = ?, reply_count = ?, quote_count = ?,
         bookmark_count = ?, view_count = ?, media_count = ?, media_json = ?, link_count = ?, links_json = ?,
         tags_json = ?, ingested_via = ?, github_urls = ?
     WHERE id = ?`,
    [
      incomingValues.tweetId,
      incomingValues.url,
      incomingValues.text,
      incomingValues.authorHandle,
      incomingValues.authorName,
      incomingValues.authorProfileImageUrl,
      incomingValues.postedAt,
      incomingValues.bookmarkedAt,
      incomingValues.syncedAt,
      incomingValues.conversationId,
      incomingValues.inReplyToStatusId,
      incomingValues.quotedStatusId,
      incomingValues.language,
      incomingValues.likeCount,
      incomingValues.repostCount,
      incomingValues.replyCount,
      incomingValues.quoteCount,
      incomingValues.bookmarkCount,
      incomingValues.viewCount,
      incomingValues.mediaCount,
      incomingValues.mediaJson,
      incomingValues.linkCount,
      incomingValues.linksJson,
      incomingValues.tagsJson,
      incomingValues.ingestedVia,
      incomingValues.githubJson,
      r.id,
    ],
  );
  ensureBookmarkProcessingRow(db, r.id);
  if (changed && options.markPendingOnChange !== false) {
    markBookmarkPendingValidation(db, r.id, 'bookmark_changed');
  }
  return { inserted: false, changed };
}

export async function buildIndex(options?: { force?: boolean }): Promise<{ dbPath: string; recordCount: number; newRecords: number }> {
  const cachePath = twitterBookmarksCachePath();
  const dbPath = twitterBookmarksIndexPath();
  const records = await readJsonLines<BookmarkRecord>(cachePath);

  const db = await openDb(dbPath);
  try {
    if (options?.force) {
      db.run('DROP TABLE IF EXISTS bookmark_failure_events');
      db.run('DROP TABLE IF EXISTS bookmark_link_targets');
      db.run('DROP TABLE IF EXISTS bookmark_media_targets');
      db.run('DROP TABLE IF EXISTS bookmark_processing');
      db.run('DROP TABLE IF EXISTS bookmarks_fts');
      db.run('DROP TABLE IF EXISTS thread_fts');
      db.run('DROP TABLE IF EXISTS thread_tweets');
      db.run('DROP TABLE IF EXISTS bookmarks');
      db.run('DROP TABLE IF EXISTS sync_state');
      db.run('DROP TABLE IF EXISTS meta');
    }

    initSchema(db);
    ensureDbSchema(db);

    // Get existing IDs to skip
    const existingIds = new Set<string>();
    try {
      const rows = db.exec('SELECT id FROM bookmarks');
      for (const r of (rows[0]?.values ?? [])) {
        existingIds.add(r[0] as string);
      }
    } catch { /* table may be empty */ }

    const newRecords: BookmarkRecord[] = records.filter(r => !existingIds.has(r.id));

    if (newRecords.length > 0) {
      db.run('BEGIN TRANSACTION');
      for (const record of newRecords) {
        upsertBookmarkRecord(db, record);
      }
      db.run('COMMIT');
    }

    // Rebuild FTS index from content table
    db.run(`INSERT INTO bookmarks_fts(bookmarks_fts) VALUES('rebuild')`);

    saveDb(db, dbPath);
    const totalRows = db.exec('SELECT COUNT(*) FROM bookmarks')[0]?.values[0]?.[0] as number;
    return { dbPath, recordCount: totalRows, newRecords: newRecords.length };
  } finally {
    db.close();
  }
}

function hasThreadTable(db: Database): boolean {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_tweets'");
  return result.length > 0 && result[0].values.length > 0;
}

function hasLinkContentTable(db: Database): boolean {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='link_content'");
  return result.length > 0 && result[0].values.length > 0;
}

export async function searchBookmarks(options: SearchOptions): Promise<SearchResult[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  const limit = options.limit ?? 20;

  try {
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.query) {
      conditions.push(`b.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ?)`);
      params.push(options.query);
    }
    if (options.author) {
      conditions.push(`b.author_handle = ? COLLATE NOCASE`);
      params.push(options.author);
    }
    if (options.after) {
      conditions.push(`b.posted_at >= ?`);
      params.push(options.after);
    }
    if (options.before) {
      conditions.push(`b.posted_at <= ?`);
      params.push(options.before);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let sql: string;
    if (options.query) {
      const includeThreads = hasThreadTable(db);
      const includeLinks = hasLinkContentTable(db);

      // Extra filter conditions shared by thread and link sub-queries
      const extraConditions: string[] = [];
      const extraParams: any[] = [];
      if (options.author) {
        extraConditions.push(`b.author_handle = ? COLLATE NOCASE`);
        extraParams.push(options.author);
      }
      if (options.after) {
        extraConditions.push(`b.posted_at >= ?`);
        extraParams.push(options.after);
      }
      if (options.before) {
        extraConditions.push(`b.posted_at <= ?`);
        extraParams.push(options.before);
      }
      const extraWhere = extraConditions.length > 0 ? `AND ${extraConditions.join(' AND ')}` : '';

      if (includeThreads || includeLinks) {
        // Bookmark query: FTS match + filters
        const bConditions = [...conditions]; // already includes FTS MATCH
        const bWhere = bConditions.length > 0 ? `WHERE ${bConditions.join(' AND ')}` : '';

        let unionParts = `
            SELECT b.id, b.url, b.text, b.author_handle, b.author_name, b.posted_at,
                   bm25(bookmarks_fts, 5.0, 1.0, 1.0) as score,
                   'bookmark' as source,
                   NULL as thread_match_text, NULL as thread_match_author,
                   NULL as link_match_title, NULL as link_match_url
            FROM bookmarks b
            JOIN bookmarks_fts ON bookmarks_fts.rowid = b.rowid
            ${bWhere}
        `;

        const allParams = [...params];

        if (includeThreads) {
          unionParts += `
            UNION ALL

            SELECT b.id, b.url, b.text, b.author_handle, b.author_name, b.posted_at,
                   bm25(thread_fts, 5.0, 1.0, 1.0) as score,
                   'thread' as source,
                   t.text as thread_match_text, t.author_handle as thread_match_author,
                   NULL as link_match_title, NULL as link_match_url
            FROM thread_tweets t
            JOIN thread_fts ON thread_fts.rowid = t.rowid
            JOIN bookmarks b ON b.conversation_id = t.conversation_id
            WHERE thread_fts MATCH ?
            ${extraWhere}
          `;
          allParams.push(options.query, ...extraParams);
        }

        if (includeLinks) {
          unionParts += `
            UNION ALL

            SELECT b.id, b.url, b.text, b.author_handle, b.author_name, b.posted_at,
                   bm25(link_content_fts, 5.0, 2.0) as score,
                   'link' as source,
                   NULL as thread_match_text, NULL as thread_match_author,
                   lc.title as link_match_title, lc.source_url as link_match_url
            FROM link_content lc
            JOIN link_content_fts ON link_content_fts.rowid = lc.rowid
            JOIN bookmarks b ON b.id = lc.bookmark_id
            WHERE link_content_fts MATCH ?
            ${extraWhere}
          `;
          allParams.push(options.query, ...extraParams);
        }

        sql = `
          SELECT id, url, text, author_handle, author_name, posted_at, score,
                 source, thread_match_text, thread_match_author,
                 link_match_title, link_match_url
          FROM (${unionParts})
          ORDER BY score ASC
          LIMIT ?
        `;
        allParams.push(limit);
        params.length = 0;
        params.push(...allParams);
      } else {
        sql = `
          SELECT b.id, b.url, b.text, b.author_handle, b.author_name, b.posted_at,
                 bm25(bookmarks_fts, 5.0, 1.0, 1.0) as score,
                 'bookmark' as source,
                 NULL as thread_match_text, NULL as thread_match_author,
                 NULL as link_match_title, NULL as link_match_url
          FROM bookmarks b
          JOIN bookmarks_fts ON bookmarks_fts.rowid = b.rowid
          ${where}
          ORDER BY bm25(bookmarks_fts, 5.0, 1.0, 1.0) ASC
          LIMIT ?
        `;
        params.push(limit);
      }
    } else {
      sql = `
        SELECT b.id, b.url, b.text, b.author_handle, b.author_name, b.posted_at,
               0 as score,
               'bookmark' as source,
               NULL as thread_match_text, NULL as thread_match_author,
               NULL as link_match_title, NULL as link_match_url
        FROM bookmarks b
        ${where}
        ORDER BY b.posted_at DESC
        LIMIT ?
      `;
      params.push(limit);
    }

    const rows = db.exec(sql, params);
    if (!rows.length) return [];

    return rows[0].values.map((row) => ({
      id: row[0] as string,
      url: row[1] as string,
      text: row[2] as string,
      authorHandle: row[3] as string | undefined,
      authorName: row[4] as string | undefined,
      postedAt: row[5] as string | null,
      score: row[6] as number,
      source: (row[7] as 'bookmark' | 'thread' | 'link') ?? 'bookmark',
      threadMatchText: (row[8] as string) ?? undefined,
      threadMatchAuthor: (row[9] as string) ?? undefined,
      linkMatchTitle: (row[10] as string) ?? undefined,
      linkMatchUrl: (row[11] as string) ?? undefined,
    }));
  } finally {
    db.close();
  }
}

export async function listBookmarks(
  filters: BookmarkTimelineFilters = {},
): Promise<BookmarkTimelineItem[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  const limit = filters.limit ?? 30;
  const offset = filters.offset ?? 0;

  try {
    const { where, params } = buildBookmarkWhereClause(filters);
    const sql = `
      SELECT
        b.id,
        b.tweet_id,
        b.url,
        b.text,
        b.author_handle,
        b.author_name,
        b.author_profile_image_url,
        b.posted_at,
        b.bookmarked_at,
        b.categories,
        b.primary_category,
        b.domains,
        b.primary_domain,
        b.github_urls,
        b.links_json,
        b.media_count,
        b.link_count,
        b.like_count,
        b.repost_count,
        b.reply_count,
        b.quote_count,
        b.bookmark_count,
        b.view_count
      FROM bookmarks b
      ${where}
      ${bookmarkSortClause(filters.sort)}
      LIMIT ?
      OFFSET ?
    `;
    params.push(limit, offset);

    const rows = db.exec(sql, params);
    if (!rows.length) return [];
    return rows[0].values.map((row) => mapTimelineRow(row));
  } finally {
    db.close();
  }
}

export async function countBookmarks(
  filters: BookmarkTimelineFilters = {},
): Promise<number> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);

  try {
    const { where, params } = buildBookmarkWhereClause(filters);
    const sql = `
      SELECT COUNT(*)
      FROM bookmarks b
      ${where}
    `;
    const rows = db.exec(sql, params);
    return Number(rows[0]?.values?.[0]?.[0] ?? 0);
  } finally {
    db.close();
  }
}

export async function exportBookmarksForSyncSeed(): Promise<BookmarkRecord[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);

  try {
    const sql = `
      SELECT
        b.id,
        b.tweet_id,
        b.url,
        b.text,
        b.author_handle,
        b.author_name,
        b.author_profile_image_url,
        b.posted_at,
        b.bookmarked_at,
        b.synced_at,
        b.conversation_id,
        b.in_reply_to_status_id,
        b.quoted_status_id,
        b.language,
        b.like_count,
        b.repost_count,
        b.reply_count,
        b.quote_count,
        b.bookmark_count,
        b.view_count,
        b.links_json
      FROM bookmarks b
      ${bookmarkSortClause('desc')}
    `;
    const rows = db.exec(sql);
    if (!rows.length) return [];

    return rows[0].values.map((row) => ({
      id: String(row[0]),
      tweetId: String(row[1]),
      url: String(row[2]),
      text: String(row[3] ?? ''),
      authorHandle: (row[4] as string) ?? undefined,
      authorName: (row[5] as string) ?? undefined,
      authorProfileImageUrl: (row[6] as string) ?? undefined,
      postedAt: (row[7] as string) ?? null,
      bookmarkedAt: (row[8] as string) ?? null,
      syncedAt: String(row[9] ?? row[8] ?? row[7] ?? new Date(0).toISOString()),
      conversationId: (row[10] as string) ?? undefined,
      inReplyToStatusId: (row[11] as string) ?? undefined,
      quotedStatusId: (row[12] as string) ?? undefined,
      language: (row[13] as string) ?? undefined,
      engagement: {
        likeCount: row[14] as number | undefined,
        repostCount: row[15] as number | undefined,
        replyCount: row[16] as number | undefined,
        quoteCount: row[17] as number | undefined,
        bookmarkCount: row[18] as number | undefined,
        viewCount: row[19] as number | undefined,
      },
      links: parseJsonArray(row[20]),
      tags: [],
      ingestedVia: 'graphql',
    }));
  } finally {
    db.close();
  }
}

export async function getBookmarkById(id: string): Promise<BookmarkTimelineItem | null> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);

  try {
    const rows = db.exec(
      `SELECT
        b.id,
        b.tweet_id,
        b.url,
        b.text,
        b.author_handle,
        b.author_name,
        b.author_profile_image_url,
        b.posted_at,
        b.bookmarked_at,
        b.categories,
        b.primary_category,
        b.domains,
        b.primary_domain,
        b.github_urls,
        b.links_json,
        b.media_count,
        b.link_count,
        b.like_count,
        b.repost_count,
        b.reply_count,
        b.quote_count,
        b.bookmark_count,
        b.view_count
      FROM bookmarks b
      WHERE b.id = ?
      LIMIT 1`,
      [id]
    );
    const row = rows[0]?.values?.[0];
    return row ? mapTimelineRow(row) : null;
  } finally {
    db.close();
  }
}

export async function getStats(): Promise<{
  totalBookmarks: number;
  uniqueAuthors: number;
  dateRange: { earliest: string | null; latest: string | null };
  topAuthors: { handle: string; count: number }[];
  languageBreakdown: { language: string; count: number }[];
}> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);

  try {
    const total = db.exec('SELECT COUNT(*) FROM bookmarks')[0]?.values[0]?.[0] as number;
    const authors = db.exec('SELECT COUNT(DISTINCT author_handle) FROM bookmarks')[0]?.values[0]?.[0] as number;
    const range = db.exec('SELECT MIN(posted_at), MAX(posted_at) FROM bookmarks WHERE posted_at IS NOT NULL')[0]?.values[0];

    const topAuthorsRows = db.exec(
      `SELECT author_handle, COUNT(*) as c FROM bookmarks
       WHERE author_handle IS NOT NULL
       GROUP BY author_handle ORDER BY c DESC LIMIT 15`
    );
    const topAuthors = (topAuthorsRows[0]?.values ?? []).map((r) => ({
      handle: r[0] as string,
      count: r[1] as number,
    }));

    const langRows = db.exec(
      `SELECT language, COUNT(*) as c FROM bookmarks
       WHERE language IS NOT NULL
       GROUP BY language ORDER BY c DESC LIMIT 10`
    );
    const languageBreakdown = (langRows[0]?.values ?? []).map((r) => ({
      language: r[0] as string,
      count: r[1] as number,
    }));

    return {
      totalBookmarks: total,
      uniqueAuthors: authors,
      dateRange: { earliest: (range?.[0] as string) ?? null, latest: (range?.[1] as string) ?? null },
      topAuthors,
      languageBreakdown,
    };
  } finally {
    db.close();
  }
}

export async function getBookmarkStorageStatus(): Promise<{ totalBookmarks: number; lastUpdated: string | null }> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(`SELECT COUNT(*), MAX(synced_at) FROM bookmarks`);
    return {
      totalBookmarks: Number(rows[0]?.values?.[0]?.[0] ?? 0),
      lastUpdated: (rows[0]?.values?.[0]?.[1] as string) ?? null,
    };
  } finally {
    db.close();
  }
}

// ── Classification ───────────────────────────────────────────────────────

export async function classifyAndRebuild(): Promise<{
  dbPath: string;
  recordCount: number;
  summary: ClassificationSummary;
}> {
  const cachePath = twitterBookmarksCachePath();
  const dbPath = twitterBookmarksIndexPath();
  const records = await readJsonLines<BookmarkRecord>(cachePath);
  const { results, summary } = classifyCorpus(records);

  // Rebuild index then apply regex classifications
  const buildResult = await buildIndex();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const stmt = db.prepare(`UPDATE bookmarks SET categories = ?, primary_category = ?, github_urls = ? WHERE id = ? AND (primary_category = 'unclassified' OR primary_category IS NULL)`);
    for (const [id, r] of results) {
      if (r.categories.length > 0) {
        stmt.run([r.categories.join(','), r.primary, r.githubUrls.length ? JSON.stringify(r.githubUrls) : null, id]);
      }
    }
    stmt.free();
    saveDb(db, dbPath);
  } finally {
    db.close();
  }
  return { ...buildResult, summary };
}

export interface CategorySample {
  id: string;
  url: string;
  text: string;
  authorHandle?: string;
  categories: string;
  githubUrls?: string;
  links?: string;
}

export async function sampleByCategory(
  category: string,
  limit: number,
): Promise<CategorySample[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  try {
    const rows = db.exec(
      `SELECT id, url, text, author_handle, categories, github_urls, links_json
       FROM bookmarks
       WHERE categories LIKE ?
       ORDER BY RANDOM()
       LIMIT ?`,
      [`%${category}%`, limit]
    );
    if (!rows.length) return [];
    return rows[0].values.map((r) => ({
      id: r[0] as string,
      url: r[1] as string,
      text: r[2] as string,
      authorHandle: (r[3] as string) ?? undefined,
      categories: (r[4] as string) ?? '',
      githubUrls: (r[5] as string) ?? undefined,
      links: (r[6] as string) ?? undefined,
    }));
  } finally {
    db.close();
  }
}

export async function getCategoryCounts(): Promise<Record<string, number>> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(
      `SELECT primary_category, COUNT(*) as c FROM bookmarks
       WHERE primary_category IS NOT NULL
       GROUP BY primary_category ORDER BY c DESC`
    );
    const counts: Record<string, number> = {};
    for (const row of rows[0]?.values ?? []) {
      counts[row[0] as string] = row[1] as number;
    }
    return counts;
  } finally {
    db.close();
  }
}

export async function getDomainCounts(): Promise<Record<string, number>> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(
      `SELECT primary_domain, COUNT(*) as c FROM bookmarks
       WHERE primary_domain IS NOT NULL
       GROUP BY primary_domain ORDER BY c DESC`
    );
    const counts: Record<string, number> = {};
    for (const row of rows[0]?.values ?? []) {
      counts[row[0] as string] = row[1] as number;
    }
    return counts;
  } finally {
    db.close();
  }
}

export async function sampleByDomain(
  domain: string,
  limit: number,
): Promise<CategorySample[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(
      `SELECT id, url, text, author_handle, categories, github_urls, links_json
       FROM bookmarks
       WHERE domains LIKE ?
       ORDER BY RANDOM()
       LIMIT ?`,
      [`%${domain}%`, limit]
    );
    if (!rows.length) return [];
    return rows[0].values.map((r) => ({
      id: r[0] as string,
      url: r[1] as string,
      text: r[2] as string,
      authorHandle: (r[3] as string) ?? undefined,
      categories: (r[4] as string) ?? '',
      githubUrls: (r[5] as string) ?? undefined,
      links: (r[6] as string) ?? undefined,
    }));
  } finally {
    db.close();
  }
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';

  return results
    .map((r, i) => {
      const author = r.authorHandle ? `@${r.authorHandle}` : 'unknown';
      const date = r.postedAt ? r.postedAt.slice(0, 10) : '?';
      const text = r.text.length > 140 ? r.text.slice(0, 140) + '...' : r.text;
      let line = `${i + 1}. [${date}] ${author}\n   ${text}`;
      if (r.threadMatchText) {
        const threadAuthor = r.threadMatchAuthor ? `@${r.threadMatchAuthor}` : '?';
        const snippet = r.threadMatchText.length > 100 ? r.threadMatchText.slice(0, 100) + '...' : r.threadMatchText;
        line += `\n   \u21b3 thread match: ${threadAuthor} "${snippet}"`;
      }
      if (r.linkMatchTitle) {
        const linkUrl = r.linkMatchUrl ? ` (${r.linkMatchUrl})` : '';
        line += `\n   \u2197 link match: "${r.linkMatchTitle}"${linkUrl}`;
      }
      line += `\n   ${r.url}`;
      return line;
    })
    .join('\n\n');
}

// ── Thread DB functions ───────────────────────────────────────────────────

export function insertThreadTweet(db: Database, r: ThreadTweetRecord): void {
  db.run(
    `INSERT OR REPLACE INTO thread_tweets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      r.id,
      r.tweetId,
      r.conversationId,
      r.url,
      r.text,
      r.authorHandle ?? null,
      r.authorName ?? null,
      r.authorProfileImageUrl ?? null,
      r.postedAt ?? null,
      r.syncedAt,
      r.inReplyToStatusId ?? null,
      r.parentTweetId ?? null,
      r.threadPosition,
      r.isRoot ? 1 : 0,
      r.language ?? null,
      r.engagement?.likeCount ?? null,
      r.engagement?.repostCount ?? null,
      r.engagement?.replyCount ?? null,
      r.engagement?.viewCount ?? null,
      r.media?.length ?? 0,
      r.media?.length ? JSON.stringify(r.media) : null,
      r.links?.length ?? 0,
      r.links?.length ? JSON.stringify(r.links) : null,
    ]
  );
}

export async function getThreadTweets(conversationId: string): Promise<ThreadTweetRecord[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const hasTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_tweets'");
    if (!hasTable.length || !hasTable[0].values.length) return [];

    const rows = db.exec(
      `SELECT id, tweet_id, conversation_id, url, text,
              author_handle, author_name, author_profile_image_url,
              posted_at, synced_at, in_reply_to_status_id, parent_tweet_id,
              thread_position, is_root, language,
              like_count, repost_count, reply_count, view_count,
              media_count, media_json, link_count, links_json
       FROM thread_tweets
       WHERE conversation_id = ?
       ORDER BY thread_position ASC`,
      [conversationId]
    );
    if (!rows.length) return [];
    return rows[0].values.map((row) => ({
      id: row[0] as string,
      tweetId: row[1] as string,
      conversationId: row[2] as string,
      url: row[3] as string,
      text: row[4] as string,
      authorHandle: (row[5] as string) ?? undefined,
      authorName: (row[6] as string) ?? undefined,
      authorProfileImageUrl: (row[7] as string) ?? undefined,
      postedAt: (row[8] as string) ?? null,
      syncedAt: row[9] as string,
      inReplyToStatusId: (row[10] as string) ?? undefined,
      parentTweetId: (row[11] as string) ?? undefined,
      threadPosition: row[12] as number,
      isRoot: Boolean(row[13]),
      language: (row[14] as string) ?? undefined,
      engagement: {
        likeCount: row[15] as number | undefined,
        repostCount: row[16] as number | undefined,
        replyCount: row[17] as number | undefined,
        viewCount: row[18] as number | undefined,
      },
      media: parseJsonArray(row[20]),
      links: parseJsonArray(row[22]),
    }));
  } finally {
    db.close();
  }
}

export async function getBookmarkConversationId(id: string): Promise<string | null> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(`SELECT conversation_id FROM bookmarks WHERE id = ? LIMIT 1`, [id]);
    return (rows[0]?.values?.[0]?.[0] as string) ?? null;
  } finally {
    db.close();
  }
}

export interface LinkContentRow {
  sourceUrl: string;
  resolvedUrl: string | null;
  contentType: string;
  title: string | null;
  content: string;
  contentBytes: number | null;
}

export async function getLinkContentForBookmark(bookmarkId: string): Promise<LinkContentRow[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  try {
    if (!hasLinkContentTable(db)) return [];
    const rows = db.exec(
      `SELECT source_url, resolved_url, content_type, title, content, content_bytes
       FROM link_content WHERE bookmark_id = ?`,
      [bookmarkId]
    );
    if (!rows.length) return [];
    return rows[0].values.map((row) => ({
      sourceUrl: row[0] as string,
      resolvedUrl: (row[1] as string) ?? null,
      contentType: row[2] as string,
      title: (row[3] as string) ?? null,
      content: row[4] as string,
      contentBytes: (row[5] as number) ?? null,
    }));
  } finally {
    db.close();
  }
}

// ── Export helpers ────────────────────────────────────────────────────────

export interface ExportableBookmark extends BookmarkTimelineItem {
  conversationId?: string | null;
  tagsJson: string[];
  threadFetched: number;
  exportedAt?: string | null;
}

export interface ExportFilters {
  force?: boolean;
  skipThreads?: boolean;
  author?: string;
  category?: string;
  domain?: string;
  after?: string;
  before?: string;
  limit?: number;
}

function mapExportableRow(row: unknown[]): ExportableBookmark {
  return {
    id: row[0] as string,
    tweetId: row[1] as string,
    url: row[2] as string,
    text: row[3] as string,
    authorHandle: (row[4] as string) ?? undefined,
    authorName: (row[5] as string) ?? undefined,
    authorProfileImageUrl: (row[6] as string) ?? undefined,
    postedAt: (row[7] as string) ?? null,
    bookmarkedAt: (row[8] as string) ?? null,
    categories: parseCsv(row[9]),
    primaryCategory: (row[10] as string) ?? null,
    domains: parseCsv(row[11]),
    primaryDomain: (row[12] as string) ?? null,
    githubUrls: parseJsonArray(row[13]),
    links: parseJsonArray(row[14]),
    mediaCount: Number(row[15] ?? 0),
    linkCount: Number(row[16] ?? 0),
    likeCount: row[17] as number | null,
    repostCount: row[18] as number | null,
    replyCount: row[19] as number | null,
    quoteCount: row[20] as number | null,
    bookmarkCount: row[21] as number | null,
    viewCount: row[22] as number | null,
    conversationId: (row[23] as string) ?? null,
    tagsJson: parseJsonArray(row[24]),
    threadFetched: Number(row[25] ?? 0),
    exportedAt: (row[26] as string) ?? null,
  };
}

export async function getBookmarksForExport(filters: ExportFilters): Promise<ExportableBookmark[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (!filters.force) {
      conditions.push('b.exported_at IS NULL');
    }
    if (!filters.skipThreads) {
      conditions.push(`(p.thread_status = 'complete' OR b.conversation_id IS NULL)`);
    }
    if (filters.author) {
      conditions.push('b.author_handle = ? COLLATE NOCASE');
      params.push(filters.author);
    }
    if (filters.category) {
      conditions.push('b.categories LIKE ?');
      params.push(`%${filters.category}%`);
    }
    if (filters.domain) {
      conditions.push('b.domains LIKE ?');
      params.push(`%${filters.domain}%`);
    }
    if (filters.after) {
      conditions.push('COALESCE(b.posted_at, b.bookmarked_at) >= ?');
      params.push(filters.after);
    }
    if (filters.before) {
      conditions.push('COALESCE(b.posted_at, b.bookmarked_at) <= ?');
      params.push(filters.before);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ? `LIMIT ${filters.limit}` : '';

    const rows = db.exec(
      `SELECT b.id, b.tweet_id, b.url, b.text,
              b.author_handle, b.author_name, b.author_profile_image_url,
              b.posted_at, b.bookmarked_at,
              b.categories, b.primary_category,
              b.domains, b.primary_domain,
              b.github_urls, b.links_json,
              b.media_count, b.link_count,
              b.like_count, b.repost_count, b.reply_count, b.quote_count,
              b.bookmark_count, b.view_count,
              b.conversation_id, b.tags_json,
              CASE WHEN p.thread_status = 'complete' THEN 1 ELSE 0 END,
              b.exported_at
       FROM bookmarks b
       LEFT JOIN bookmark_processing p ON p.bookmark_id = b.id
       ${where}
       ${bookmarkSortClause('desc')}
       ${limit}`,
      params
    );
    if (!rows.length) return [];
    return rows[0].values.map(mapExportableRow);
  } finally {
    db.close();
  }
}

export async function markBookmarkExported(id: string, timestamp: string): Promise<void> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    db.run('UPDATE bookmarks SET exported_at = ? WHERE id = ?', [timestamp, id]);
    await saveDb(db, dbPath);
  } finally {
    db.close();
  }
}

export async function markBookmarksExportedBatch(ids: string[], timestamp: string): Promise<void> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    for (const id of ids) {
      db.run('UPDATE bookmarks SET exported_at = ? WHERE id = ?', [timestamp, id]);
    }
    await saveDb(db, dbPath);
  } finally {
    db.close();
  }
}

export async function getExportStats(): Promise<{ total: number; exported: number; unexported: number }> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const totalRows = db.exec('SELECT COUNT(*) FROM bookmarks');
    const exportedRows = db.exec('SELECT COUNT(*) FROM bookmarks WHERE exported_at IS NOT NULL');
    const total = Number(totalRows[0]?.values?.[0]?.[0] ?? 0);
    const exported = Number(exportedRows[0]?.values?.[0]?.[0] ?? 0);
    return { total, exported, unexported: total - exported };
  } finally {
    db.close();
  }
}

export async function getExportOutputDir(): Promise<string | null> {
  const metaPath = twitterBookmarksMetaPath();
  if (!await pathExists(metaPath)) return null;
  const meta = await readJson<Record<string, unknown>>(metaPath);
  return (meta.exportOutputDir as string) ?? null;
}

export async function setExportOutputDir(dir: string): Promise<void> {
  const metaPath = twitterBookmarksMetaPath();
  const meta = await pathExists(metaPath) ? await readJson<Record<string, unknown>>(metaPath) : {};
  meta.exportOutputDir = dir;
  await writeJson(metaPath, meta);
}

export interface BookmarkMediaTargetRow {
  id: string;
  bookmarkId: string;
  tweetId: string;
  sourceUrl: string;
  contentType?: string | null;
  localPath?: string | null;
  bytes?: number | null;
  status: string;
  attemptCount: number;
  lastError?: string | null;
  lastAttemptAt?: string | null;
  downloadedAt?: string | null;
  updatedAt: string;
}

export interface BookmarkLinkTargetRow {
  id: string;
  bookmarkId: string;
  sourceUrl: string;
  resolvedUrl?: string | null;
  contentType?: string | null;
  status: string;
  attemptCount: number;
  lastError?: string | null;
  lastAttemptAt?: string | null;
  fetchedAt?: string | null;
  updatedAt: string;
}

function mapFailureEventRow(row: unknown[]): BookmarkFailureEventRow {
  return {
    id: row[0] as string,
    bookmarkId: row[1] as string,
    step: row[2] as string,
    targetKind: row[3] as string,
    targetRef: (row[4] as string) ?? null,
    failureCode: row[5] as string,
    failureMessage: row[6] as string,
    retryable: Boolean(row[7]),
    processingState: (row[8] as string) ?? null,
    occurredAt: row[9] as string,
  };
}

function mapProcessingRow(row: unknown[]): BookmarkProcessingRow {
  return {
    bookmarkId: row[0] as string,
    processingState: row[1] as BookmarkProcessingState,
    coreStatus: row[2] as BookmarkStepStatus,
    threadStatus: row[3] as BookmarkStepStatus,
    mediaStatus: row[4] as BookmarkStepStatus,
    linksStatus: row[5] as BookmarkStepStatus,
    attemptCount: Number(row[6] ?? 0),
    lastErrorStep: (row[7] as string) ?? null,
    lastErrorCode: (row[8] as string) ?? null,
    lastErrorMessage: (row[9] as string) ?? null,
    nextRetryAt: (row[10] as string) ?? null,
    claimedAt: (row[11] as string) ?? null,
    claimOwner: (row[12] as string) ?? null,
    completedAt: (row[13] as string) ?? null,
    requiresRevalidation: Boolean(row[14]),
    updatedAt: row[15] as string,
  };
}

function mapMediaTargetRow(row: unknown[]): BookmarkMediaTargetRow {
  return {
    id: row[0] as string,
    bookmarkId: row[1] as string,
    tweetId: row[2] as string,
    sourceUrl: row[3] as string,
    contentType: (row[4] as string) ?? null,
    localPath: (row[5] as string) ?? null,
    bytes: (row[6] as number) ?? null,
    status: row[7] as string,
    attemptCount: Number(row[8] ?? 0),
    lastError: (row[9] as string) ?? null,
    lastAttemptAt: (row[10] as string) ?? null,
    downloadedAt: (row[11] as string) ?? null,
    updatedAt: row[12] as string,
  };
}

function mapLinkTargetRow(row: unknown[]): BookmarkLinkTargetRow {
  return {
    id: row[0] as string,
    bookmarkId: row[1] as string,
    sourceUrl: row[2] as string,
    resolvedUrl: (row[3] as string) ?? null,
    contentType: (row[4] as string) ?? null,
    status: row[5] as string,
    attemptCount: Number(row[6] ?? 0),
    lastError: (row[7] as string) ?? null,
    lastAttemptAt: (row[8] as string) ?? null,
    fetchedAt: (row[9] as string) ?? null,
    updatedAt: row[10] as string,
  };
}

export async function getBookmarkProcessing(bookmarkId: string): Promise<BookmarkProcessingRow | null> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(
      `SELECT bookmark_id, processing_state, core_status, thread_status, media_status, links_status,
              attempt_count, last_error_step, last_error_code, last_error_message,
              next_retry_at, claimed_at, claim_owner, completed_at, requires_revalidation, updated_at
       FROM bookmark_processing
       WHERE bookmark_id = ?`,
      [bookmarkId],
    );
    const row = rows[0]?.values?.[0];
    return row ? mapProcessingRow(row) : null;
  } finally {
    db.close();
  }
}

export async function listIncompleteBookmarks(limit = 50): Promise<IncompleteBookmarkItem[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(
      `SELECT
         b.id,
         b.tweet_id,
         b.url,
         b.text,
         b.author_handle,
         b.author_name,
         b.author_profile_image_url,
         b.posted_at,
         b.bookmarked_at,
         b.categories,
         b.primary_category,
         b.domains,
         b.primary_domain,
         b.github_urls,
         b.links_json,
         b.media_count,
         b.link_count,
         b.like_count,
         b.repost_count,
         b.reply_count,
         b.quote_count,
         b.bookmark_count,
         b.view_count,
         p.processing_state,
         p.core_status,
         p.thread_status,
         p.media_status,
         p.links_status,
         p.attempt_count,
         p.last_error_step,
         p.last_error_code,
         p.last_error_message,
         p.completed_at,
         p.next_retry_at
       FROM bookmarks b
       JOIN bookmark_processing p ON p.bookmark_id = b.id
       WHERE p.processing_state != 'complete'
       ${bookmarkSortClause('desc')}
       LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];
    return rows[0].values.map((row) => ({
      ...mapTimelineRow(row.slice(0, 23)),
      processingState: row[23] as BookmarkProcessingState,
      coreStatus: row[24] as BookmarkStepStatus,
      threadStatus: row[25] as BookmarkStepStatus,
      mediaStatus: row[26] as BookmarkStepStatus,
      linksStatus: row[27] as BookmarkStepStatus,
      attemptCount: Number(row[28] ?? 0),
      lastErrorStep: (row[29] as string) ?? null,
      lastErrorCode: (row[30] as string) ?? null,
      lastErrorMessage: (row[31] as string) ?? null,
      completedAt: (row[32] as string) ?? null,
      nextRetryAt: (row[33] as string) ?? null,
    }));
  } finally {
    db.close();
  }
}

export function insertBookmarkFailureEvent(
  db: Database,
  event: BookmarkFailureEventRow,
): void {
  ensureFailureEventSchema(db);
  db.run(
    `INSERT INTO bookmark_failure_events (
      id, bookmark_id, step, target_kind, target_ref,
      failure_code, failure_message, retryable, processing_state, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.bookmarkId,
      event.step,
      event.targetKind,
      event.targetRef ?? null,
      event.failureCode,
      event.failureMessage,
      event.retryable ? 1 : 0,
      event.processingState ?? null,
      event.occurredAt,
    ],
  );
}

export async function listFailureEvents(options: {
  limit?: number;
  bookmarkId?: string;
  retryableOnly?: boolean;
} = {}): Promise<FailureEventItem[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (options.bookmarkId) {
      conditions.push('e.bookmark_id = ?');
      params.push(options.bookmarkId);
    }
    if (options.retryableOnly) {
      conditions.push('e.retryable = 1');
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    const rows = db.exec(
      `SELECT
         e.id,
         e.bookmark_id,
         e.step,
         e.target_kind,
         e.target_ref,
         e.failure_code,
         e.failure_message,
         e.retryable,
         e.processing_state,
         e.occurred_at,
         b.url,
         b.text,
         b.author_handle,
         b.author_name
       FROM bookmark_failure_events e
       JOIN bookmarks b ON b.id = e.bookmark_id
       ${where}
       ORDER BY e.occurred_at DESC
       LIMIT ?`,
      [...params, limit],
    );
    if (!rows.length) return [];
    return rows[0].values.map((row) => ({
      ...mapFailureEventRow(row.slice(0, 10)),
      url: row[10] as string,
      text: row[11] as string,
      authorHandle: (row[12] as string) ?? undefined,
      authorName: (row[13] as string) ?? undefined,
    }));
  } finally {
    db.close();
  }
}

export async function getRetryableBookmarkIds(limit = 100): Promise<string[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  const now = new Date().toISOString();
  try {
    const rows = db.exec(
      `SELECT bookmark_id
       FROM bookmark_processing
       WHERE processing_state IN ('pending', 'retryable_failed')
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY updated_at ASC
       LIMIT ?`,
      [now, limit],
    );
    return rows[0]?.values?.map((row) => row[0] as string) ?? [];
  } finally {
    db.close();
  }
}

export async function getNewestStoredBookmarkId(): Promise<string | null> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(
      `SELECT id
       FROM bookmarks b
       ${bookmarkSortClause('desc')}
       LIMIT 1`,
    );
    return (rows[0]?.values?.[0]?.[0] as string) ?? null;
  } finally {
    db.close();
  }
}

export async function getDownloadedMediaTargetsForBookmark(bookmarkId: string): Promise<BookmarkMediaTargetRow[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(
      `SELECT id, bookmark_id, tweet_id, source_url, content_type, local_path, bytes, status,
              attempt_count, last_error, last_attempt_at, downloaded_at, updated_at
       FROM bookmark_media_targets
       WHERE bookmark_id = ? AND status = 'downloaded'
       ORDER BY downloaded_at ASC, updated_at ASC`,
      [bookmarkId],
    );
    if (!rows.length) return [];
    return rows[0].values.map(mapMediaTargetRow);
  } finally {
    db.close();
  }
}

export async function getAllMediaTargetsForBookmark(bookmarkId: string): Promise<BookmarkMediaTargetRow[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(
      `SELECT id, bookmark_id, tweet_id, source_url, content_type, local_path, bytes, status,
              attempt_count, last_error, last_attempt_at, downloaded_at, updated_at
       FROM bookmark_media_targets
       WHERE bookmark_id = ?
       ORDER BY updated_at ASC`,
      [bookmarkId],
    );
    if (!rows.length) return [];
    return rows[0].values.map(mapMediaTargetRow);
  } finally {
    db.close();
  }
}

export async function getAllLinkTargetsForBookmark(bookmarkId: string): Promise<BookmarkLinkTargetRow[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureDbSchema(db);
  try {
    const rows = db.exec(
      `SELECT id, bookmark_id, source_url, resolved_url, content_type, status,
              attempt_count, last_error, last_attempt_at, fetched_at, updated_at
       FROM bookmark_link_targets
       WHERE bookmark_id = ?
       ORDER BY updated_at ASC`,
      [bookmarkId],
    );
    if (!rows.length) return [];
    return rows[0].values.map(mapLinkTargetRow);
  } finally {
    db.close();
  }
}
