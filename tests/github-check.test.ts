import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectGithubToken, runGithubTokenCheck } from '../src/github-check.js';

function makeEnvRoots(): { cwd: string; dataDirectory: string; homeDirectory: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-github-check-'));
  const dataDirectory = path.join(cwd, 'data');
  const homeDirectory = path.join(cwd, 'home');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(homeDirectory, { recursive: true });
  return { cwd, dataDirectory, homeDirectory };
}

test('inspectGithubToken shows which token wins when both vars are present', () => {
  const roots = makeEnvRoots();
  fs.writeFileSync(path.join(roots.cwd, '.env.local'), 'GITHUB_TOKEN=file-token\n');

  const result = inspectGithubToken({
    ...roots,
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: 'shell-token',
    },
  });

  assert.equal(result.active?.name, 'GITHUB_TOKEN');
  assert.equal(result.active?.source, 'file');
  assert.ok(result.precedenceNote);
  const patBinding = result.bindings.find((binding) => binding.name === 'GITHUB_PERSONAL_ACCESS_TOKEN');
  assert.equal(patBinding?.source, 'process');
  assert.equal(patBinding?.present, true);
});

test('runGithubTokenCheck reports a valid token with login and scopes', async () => {
  const result = await runGithubTokenCheck({
    env: {
      GITHUB_TOKEN: 'good-token',
    },
    fetchImpl: async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer good-token');
      return new Response(JSON.stringify({ login: 'octocat' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-oauth-scopes': 'gist, repo',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': '9999999999',
        },
      });
    },
  });

  assert.equal(result.validation, 'valid');
  assert.equal(result.login, 'octocat');
  assert.deepEqual(result.scopes, ['gist', 'repo']);
  assert.equal(result.rateLimitRemaining, '4999');
});

test('runGithubTokenCheck reports unauthorized when GitHub rejects the active token', async () => {
  const roots = makeEnvRoots();
  fs.writeFileSync(path.join(roots.cwd, '.env'), 'GITHUB_PERSONAL_ACCESS_TOKEN=backup-token\n');

  const result = await runGithubTokenCheck({
    ...roots,
    env: {
      GITHUB_TOKEN: 'bad-token',
    },
    fetchImpl: async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer bad-token');
      return new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '5000',
          'x-ratelimit-reset': '9999999999',
        },
      });
    },
  });

  assert.equal(result.validation, 'unauthorized');
  assert.equal(result.statusCode, 401);
  assert.equal(result.message, 'Bad credentials');
  assert.equal(result.active?.name, 'GITHUB_TOKEN');
  assert.equal(result.active?.source, 'process');
});

test('runGithubTokenCheck skips validation when no usable token is configured', async () => {
  const roots = makeEnvRoots();
  const result = await runGithubTokenCheck({
    ...roots,
    env: {},
    fetchImpl: async () => {
      throw new Error('should not fetch without a token');
    },
  });

  assert.equal(result.validation, 'skipped_missing_token');
  assert.equal(result.active, undefined);
  assert.ok(result.checkedPaths.every((value) => typeof value === 'string'));
});
