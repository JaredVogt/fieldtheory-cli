import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLinkContentByUrl } from '../src/fetch-links.js';

function installFetchMock(handler: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('fetchLinkContentByUrl forwards GitHub token to README API requests', async (t) => {
  let authHeader: string | undefined;
  const restoreFetch = installFetchMock(async (url, init) => {
    if (url === 'https://api.github.com/repos/acme/repo/readme') {
      authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response('README body', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'x-ratelimit-remaining': '5000',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      });
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const result = await fetchLinkContentByUrl('https://github.com/acme/repo', { githubToken: 'secret-token' });
  assert.equal(authHeader, 'Bearer secret-token');
  assert.equal(result.failure, undefined);
  assert.equal(result.retryable, false);
  assert.equal(result.fetchedContent?.title, 'acme/repo README');
});

test('fetchLinkContentByUrl reports explicit GitHub unauthorized failures', async (t) => {
  const restoreFetch = installFetchMock(async (url) => {
    if (url === 'https://api.github.com/repos/acme/private/readme') {
      return new Response('bad credentials', {
        status: 401,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      });
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const result = await fetchLinkContentByUrl('https://github.com/acme/private', { githubToken: 'bad-token' });
  assert.equal(result.failure, 'github_unauthorized');
  assert.equal(result.retryable, false);
  assert.equal(result.fetchedContent, null);
});

test('fetchLinkContentByUrl reports explicit empty gist failures', async (t) => {
  const restoreFetch = installFetchMock(async (url) => {
    if (url === 'https://api.github.com/gists/123456') {
      return new Response(JSON.stringify({ description: 'empty gist', files: {} }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '5000',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      });
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const result = await fetchLinkContentByUrl('https://gist.github.com/alice/123456', { githubToken: 'secret-token' });
  assert.equal(result.failure, 'github_gist_empty');
  assert.equal(result.retryable, false);
  assert.equal(result.fetchedContent, null);
});
