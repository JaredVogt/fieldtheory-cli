import { config as loadDotenv, parse as parseDotenv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dataDir } from './paths.js';

export interface ChromeSessionConfig {
  chromeUserDataDir: string;
  chromeProfileDirectory?: string;
}

export interface EnvResolutionOptions {
  cwd?: string;
  dataDirectory?: string;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedEnvBinding {
  name: string;
  value: string;
  source: 'process' | 'file';
  path?: string;
}

export interface EnvBindingsResolution {
  checkedPaths: string[];
  bindings: Partial<Record<string, ResolvedEnvBinding>>;
  selected?: ResolvedEnvBinding;
}

export function getEnvCandidatePaths(options: Omit<EnvResolutionOptions, 'env'> = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const dir = options.dataDirectory ?? dataDir();
  const home = options.homeDirectory ?? os.homedir();
  return [
    path.join(cwd, '.env.local'),
    path.join(cwd, '.env'),
    path.join(dir, '.env.local'),
    path.join(dir, '.env'),
    path.join(home, '.env'),
  ];
}

export function resolveEnvBindings(names: string[], options: EnvResolutionOptions = {}): EnvBindingsResolution {
  const env = options.env ?? process.env;
  const checkedPaths = getEnvCandidatePaths(options);
  const bindings = new Map<string, ResolvedEnvBinding>();

  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      bindings.set(name, {
        name,
        value: env[name] ?? '',
        source: 'process',
      });
    }
  }

  for (const envPath of checkedPaths) {
    if (!fs.existsSync(envPath)) continue;
    const parsed = parseDotenv(fs.readFileSync(envPath, 'utf8'));
    for (const [name, value] of Object.entries(parsed)) {
      if (bindings.has(name)) continue;
      bindings.set(name, {
        name,
        value,
        source: 'file',
        path: envPath,
      });
    }
  }

  const resultBindings: Partial<Record<string, ResolvedEnvBinding>> = {};
  for (const name of names) {
    const binding = bindings.get(name);
    if (binding) resultBindings[name] = binding;
  }

  const selected = names
    .map((name) => bindings.get(name))
    .find((binding) => binding && binding.value.trim().length > 0);

  return {
    checkedPaths,
    bindings: resultBindings,
    selected,
  };
}

export function loadEnv(options: Omit<EnvResolutionOptions, 'env'> = {}): void {
  const candidatePaths = getEnvCandidatePaths(options);

  for (const envPath of candidatePaths) {
    loadDotenv({ path: envPath, quiet: true });
  }
}

function detectChromeUserDataDir(): string | undefined {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (platform === 'linux') return path.join(home, '.config', 'google-chrome');
  if (platform === 'win32') return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  return undefined;
}

export function loadChromeSessionConfig(): ChromeSessionConfig {
  loadEnv();
  const dir = process.env.FT_CHROME_USER_DATA_DIR ?? detectChromeUserDataDir();
  if (!dir) {
    throw new Error(
      'Could not detect Chrome user-data directory.\n' +
      'Set FT_CHROME_USER_DATA_DIR in .env or pass --chrome-user-data-dir.'
    );
  }
  return {
    chromeUserDataDir: dir,
    chromeProfileDirectory: process.env.FT_CHROME_PROFILE_DIRECTORY ?? 'Default',
  };
}

export function loadXApiConfig() {
  loadEnv();

  const apiKey = process.env.X_API_KEY ?? process.env.X_CONSUMER_KEY;
  const apiSecret = process.env.X_API_SECRET ?? process.env.X_SECRET_KEY;
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  const bearerToken = process.env.X_BEARER_TOKEN;
  const callbackUrl = process.env.X_CALLBACK_URL ?? 'http://127.0.0.1:3000/callback';

  if (!apiKey || !apiSecret || !clientId || !clientSecret) {
    throw new Error(
      'Missing X API credentials for API sync.\n' +
      'Set X_API_KEY, X_API_SECRET, X_CLIENT_ID, and X_CLIENT_SECRET in .env.\n' +
      'These are only needed for --api mode. Default sync uses your Chrome session.'
    );
  }

  return { apiKey, apiSecret, clientId, clientSecret, bearerToken, callbackUrl };
}
