import type { Database } from 'sql.js';
import { openDb, saveDb } from './db.js';
import { readJsonLines, readJson, writeJson, pathExists } from './fs.js';
import { twitterBookmarksCachePath, twitterBookmarksIndexPath, twitterBookmarksMetaPath } from './paths.js';
import type { BookmarkRecord, ThreadTweetRecord } from './types.js';
import { classifyCorpus, formatClassificationSummary } from './bookmark-classify.js';
import type { ClassificationSummary } from './bookmark-classify.js';

const SCHEMA_VERSION = 8;

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

  db.run(`REPLACE INTO meta VALUES ('schema_version', '${SCHEMA_VERSION}')`);
}

function ensureMigrations(db: Database): void {
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
}

function insertRecord(db: Database, r: BookmarkRecord): void {
  // Extract GitHub URLs (kept inline — no LLM needed for URL parsing)
  const text = r.text ?? '';
  const githubMatches = text.match(/github\.com\/[\w.-]+\/[\w.-]+/gi) ?? [];
  const githubFromLinks = (r.links ?? []).filter((l) => /github\.com/i.test(l));
  const githubUrls = [...new Set([...githubMatches.map((m) => `https://${m}`), ...githubFromLinks])];

  db.run(
    `INSERT OR REPLACE INTO bookmarks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      r.id,
      r.tweetId,
      r.url,
      r.text,
      r.authorHandle ?? null,
      r.authorName ?? null,
      r.authorProfileImageUrl ?? null,
      r.postedAt ?? null,
      r.bookmarkedAt ?? null,
      r.syncedAt,
      r.conversationId ?? null,
      r.inReplyToStatusId ?? null,
      r.quotedStatusId ?? null,
      r.language ?? null,
      r.engagement?.likeCount ?? null,
      r.engagement?.repostCount ?? null,
      r.engagement?.replyCount ?? null,
      r.engagement?.quoteCount ?? null,
      r.engagement?.bookmarkCount ?? null,
      r.engagement?.viewCount ?? null,
      r.media?.length ?? 0,
      r.links?.length ?? 0,
      r.links?.length ? JSON.stringify(r.links) : null,
      r.tags?.length ? JSON.stringify(r.tags) : null,
      r.ingestedVia ?? null,
      null, // categories — populated by classify pass
      'unclassified', // primary_category
      githubUrls.length ? JSON.stringify(githubUrls) : null,
      null, // domains — populated by classify-domains pass
      null, // primary_domain
      0,    // thread_fetched
      0,    // text_refreshed
      0,    // hydrated
      null, // exported_at
    ]
  );
}

export async function buildIndex(options?: { force?: boolean }): Promise<{ dbPath: string; recordCount: number; newRecords: number }> {
  const cachePath = twitterBookmarksCachePath();
  const dbPath = twitterBookmarksIndexPath();
  const records = await readJsonLines<BookmarkRecord>(cachePath);

  const db = await openDb(dbPath);
  try {
    if (options?.force) {
      db.run('DROP TABLE IF EXISTS bookmarks_fts');
      db.run('DROP TABLE IF EXISTS bookmarks');
      db.run('DROP TABLE IF EXISTS meta');
    }

    initSchema(db);
    ensureMigrations(db);

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
        insertRecord(db, record);
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
  ensureMigrations(db);
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
  ensureMigrations(db);
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
  ensureMigrations(db);

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
  ensureMigrations(db);

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
  ensureMigrations(db);

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
  ensureMigrations(db);
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
  ensureMigrations(db);
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
  ensureMigrations(db);
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
  ensureMigrations(db);
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
    `INSERT OR REPLACE INTO thread_tweets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      r.links?.length ?? 0,
      r.links?.length ? JSON.stringify(r.links) : null,
    ]
  );
}

export async function getThreadTweets(conversationId: string): Promise<ThreadTweetRecord[]> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureMigrations(db);
  try {
    const hasTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_tweets'");
    if (!hasTable.length || !hasTable[0].values.length) return [];

    const rows = db.exec(
      `SELECT id, tweet_id, conversation_id, url, text,
              author_handle, author_name, author_profile_image_url,
              posted_at, synced_at, in_reply_to_status_id, parent_tweet_id,
              thread_position, is_root, language,
              like_count, repost_count, reply_count, view_count,
              media_count, link_count, links_json
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
      media: [],
      links: parseJsonArray(row[21]),
    }));
  } finally {
    db.close();
  }
}

export async function getBookmarkConversationId(id: string): Promise<string | null> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  ensureMigrations(db);
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
  ensureMigrations(db);
  try {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (!filters.force) {
      conditions.push('b.exported_at IS NULL');
    }
    if (!filters.skipThreads) {
      conditions.push('(b.thread_fetched = 1 OR b.conversation_id IS NULL)');
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
              b.conversation_id, b.tags_json, b.thread_fetched, b.exported_at
       FROM bookmarks b
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
  ensureMigrations(db);
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
  ensureMigrations(db);
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
  ensureMigrations(db);
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
