import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadChromeSessionConfig, resolveEnvBindings } from '../src/config.js';

test('loadChromeSessionConfig reads chrome user data dir and profile directory from env', () => {
  process.env.FT_CHROME_USER_DATA_DIR = '/tmp/chrome-user-data';
  process.env.FT_CHROME_PROFILE_DIRECTORY = 'Profile 1';
  const config = loadChromeSessionConfig('/tmp/project');
  assert.equal(config.chromeUserDataDir, '/tmp/chrome-user-data');
  assert.equal(config.chromeProfileDirectory, 'Profile 1');
  delete process.env.FT_CHROME_USER_DATA_DIR;
  delete process.env.FT_CHROME_PROFILE_DIRECTORY;
});

test('loadChromeSessionConfig defaults profile to Default', () => {
  process.env.FT_CHROME_USER_DATA_DIR = '/tmp/chrome-user-data';
  delete process.env.FT_CHROME_PROFILE_DIRECTORY;
  const config = loadChromeSessionConfig('/tmp/project');
  assert.equal(config.chromeProfileDirectory, 'Default');
  delete process.env.FT_CHROME_USER_DATA_DIR;
});

test('resolveEnvBindings matches dotenv precedence and token-name precedence', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-config-'));
  const dataDirectory = path.join(tempRoot, 'data');
  const homeDirectory = path.join(tempRoot, 'home');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(homeDirectory, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, '.env'), 'GITHUB_TOKEN=file-token\n');

  const result = resolveEnvBindings(['GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN'], {
    cwd: tempRoot,
    dataDirectory,
    homeDirectory,
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: 'shell-pat',
    },
  });

  assert.equal(result.selected?.name, 'GITHUB_TOKEN');
  assert.equal(result.selected?.value, 'file-token');
  assert.equal(result.selected?.source, 'file');
  assert.equal(result.bindings.GITHUB_PERSONAL_ACCESS_TOKEN?.source, 'process');
});
