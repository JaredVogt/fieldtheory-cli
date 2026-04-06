import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildIndex, searchBookmarks, getStats, formatSearchResults } from '../src/bookmarks-db.js';

async function setupFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ft-db-'));
  process.env.FT_DATA_DIR = dir;

  const records = [
    {
      id: '1',
      tweetId: '1',
      url: 'https://x.com/alice/status/1',
      text: 'Machine learning is transforming healthcare',
      authorHandle: 'alice',
      authorName: 'Alice Smith',
      syncedAt: '2026-01-01T00:00:00Z',
      postedAt: '2026-01-01T00:00:00Z',
      language: 'en',
      engagement: { likeCount: 100, repostCount: 10 },
      media: [],
      links: ['https://example.com'],
      tags: [],
      ingestedVia: 'graphql',
    },
    {
      id: '2',
      tweetId: '2',
      url: 'https://x.com/bob/status/2',
      text: 'Rust is a great systems programming language',
      authorHandle: 'bob',
      authorName: 'Bob Jones',
      syncedAt: '2026-02-01T00:00:00Z',
      postedAt: '2026-02-01T00:00:00Z',
      language: 'en',
      engagement: { likeCount: 50 },
      media: [],
      links: [],
      tags: [],
      ingestedVia: 'graphql',
    },
    {
      id: '3',
      tweetId: '3',
      url: 'https://x.com/alice/status/3',
      text: 'Deep learning models need massive compute',
      authorHandle: 'alice',
      authorName: 'Alice Smith',
      syncedAt: '2026-03-01T00:00:00Z',
      postedAt: '2026-03-01T00:00:00Z',
      language: 'en',
      engagement: { likeCount: 200, repostCount: 30 },
      media: ['https://img.com/1.jpg'],
      links: [],
      tags: [],
      ingestedVia: 'graphql',
    },
  ];

  await writeFile(
    path.join(dir, 'bookmarks.jsonl'),
    records.map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );
  return dir;
}

test('buildIndex creates a searchable database from the configured data dir', async () => {
  await setupFixture();
  const result = await buildIndex({ force: true });
  assert.equal(result.recordCount, 3);
  assert.equal(result.newRecords, 3);
  assert.ok(result.dbPath.endsWith('bookmarks.db'));
});

test('searchBookmarks: full-text search returns matching rows', async () => {
  await setupFixture();
  await buildIndex({ force: true });

  const results = await searchBookmarks({ query: 'learning', limit: 10 });
  assert.equal(results.length, 2);
  assert.ok(results.some((row) => row.id === '1'));
  assert.ok(results.some((row) => row.id === '3'));
});

test('searchBookmarks: author filter works without a query', async () => {
  await setupFixture();
  await buildIndex({ force: true });

  const results = await searchBookmarks({ query: '', author: 'alice', limit: 10 });
  assert.equal(results.length, 2);
  assert.ok(results.every((row) => row.authorHandle === 'alice'));
});

test('searchBookmarks: unmatched query returns zero rows', async () => {
  await setupFixture();
  await buildIndex({ force: true });

  const results = await searchBookmarks({ query: 'cryptocurrency', limit: 10 });
  assert.equal(results.length, 0);
});

test('getStats returns aggregate counts from the configured data dir', async () => {
  await setupFixture();
  await buildIndex({ force: true });

  const stats = await getStats();
  assert.equal(stats.totalBookmarks, 3);
  assert.equal(stats.uniqueAuthors, 2);
  assert.equal(stats.topAuthors[0].handle, 'alice');
  assert.equal(stats.topAuthors[0].count, 2);
});

test('formatSearchResults renders compact terminal output', () => {
  const formatted = formatSearchResults([
    {
      id: '1',
      url: 'https://x.com/test/status/1',
      text: 'Hello world',
      authorHandle: 'test',
      authorName: 'Test',
      postedAt: '2026-01-15T00:00:00Z',
      score: -1.5,
    },
  ]);

  assert.match(formatted, /@test/);
  assert.match(formatted, /2026-01-15/);
  assert.match(formatted, /Hello world/);
  assert.match(formatted, /https:\/\/x\.com\/test\/status\/1/);
});
