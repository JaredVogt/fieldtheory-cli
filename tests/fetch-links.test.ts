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

test('fetchLinkContentByUrl falls back to raw gist on API 5xx but keeps the fetch retryable', async (t) => {
  const restoreFetch = installFetchMock(async (url) => {
    if (url === 'https://api.github.com/gists/deadbeef') {
      return new Response('boom', { status: 502 });
    }
    if (url === 'https://gist.githubusercontent.com/deadbeef/raw') {
      return new Response('console.log("hello from gist")\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const result = await fetchLinkContentByUrl('https://gist.github.com/alice/deadbeef');
  // We saved partial content so the user sees something, but the call must
  // stay retryable so the next sync has a chance to get the full multi-file
  // content via the API.
  assert.ok(result.fetchedContent, 'expected fallback content');
  assert.ok(result.fetchedContent?.content.includes('[partial'), 'content should be marked partial');
  assert.equal(result.retryable, true);
  assert.equal(result.failure, 'github_gist_api_error_partial');
});

test('fetchLinkContentByUrl returns article_js_challenge as retryable on Cloudflare challenge pages', async (t) => {
  const restoreFetch = installFetchMock(async (url) => {
    if (url === 'https://blog.example.com/post') {
      // Representative Cloudflare challenge HTML (just enough to fool the
      // signature check; readers of the real page would run the JS).
      const body = `<!doctype html><html><head><title>Just a moment...</title>
        <meta http-equiv="refresh" content="5">
        <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>
      </head><body><div class="cf-challenge"><p>checking your browser before accessing example.com</p></div></body></html>`;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const result = await fetchLinkContentByUrl('https://blog.example.com/post');
  assert.equal(result.failure, 'article_js_challenge');
  assert.equal(result.retryable, true);
  assert.equal(result.fetchedContent, null);
});

test('fetchLinkContentByUrl returns pdf_too_large when content-length exceeds cap', async (t) => {
  const restoreFetch = installFetchMock(async (url) => {
    if (url === 'https://example.com/huge.pdf') {
      return new Response('%PDF-1.4 ...', {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          // 40 MB — over the 20 MB cap.
          'content-length': String(40 * 1024 * 1024),
        },
      });
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const result = await fetchLinkContentByUrl('https://example.com/huge.pdf');
  assert.equal(result.failure, 'pdf_too_large');
  assert.equal(result.retryable, false);
  assert.equal(result.fetchedContent, null);
});

test('fetchLinkContentByUrl reports pdf_unreadable terminally for corrupt/encrypted PDFs', async (t) => {
  const restoreFetch = installFetchMock(async (url) => {
    if (url === 'https://example.com/broken.pdf') {
      // Garbage bytes that unpdf will reject — we only care that the error is
      // routed to pdf_unreadable or pdf_extraction_error, not silently
      // collapsed to a generic failure.
      return new Response(new Uint8Array([0, 1, 2, 3, 4, 5]), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-length': '6',
        },
      });
    }
    return new Response('not found', { status: 404 });
  });
  t.after(restoreFetch);

  const result = await fetchLinkContentByUrl('https://example.com/broken.pdf');
  assert.equal(result.fetchedContent, null);
  assert.ok(
    result.failure?.startsWith('pdf_unreadable') || result.failure?.startsWith('pdf_extraction_error'),
    `expected pdf_unreadable or pdf_extraction_error, got ${result.failure}`,
  );
});
