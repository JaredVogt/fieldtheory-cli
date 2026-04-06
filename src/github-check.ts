import { createHash } from 'node:crypto';
import { resolveEnvBindings, type EnvResolutionOptions, type ResolvedEnvBinding } from './config.js';

const GITHUB_TOKEN_NAMES = ['GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN'] as const;
type GithubTokenName = typeof GITHUB_TOKEN_NAMES[number];

export interface GithubTokenBindingReport {
  name: GithubTokenName;
  present: boolean;
  selected: boolean;
  source: 'process' | 'file' | 'missing';
  path?: string;
  fingerprint?: string;
  valueLength?: number;
}

export interface GithubTokenInspection {
  bindings: GithubTokenBindingReport[];
  active?: GithubTokenBindingReport;
  checkedPaths: string[];
  precedenceNote?: string;
}

export type GithubValidationStatus =
  | 'skipped_missing_token'
  | 'valid'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'http_error'
  | 'network_error';

export interface GithubTokenCheckResult extends GithubTokenInspection {
  validation: GithubValidationStatus;
  statusCode?: number;
  login?: string;
  scopes: string[];
  message?: string;
  rateLimitRemaining?: string | null;
  rateLimitReset?: string | null;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function toBindingReport(name: GithubTokenName, binding: ResolvedEnvBinding | undefined, activeName?: string): GithubTokenBindingReport {
  if (!binding) {
    return {
      name,
      present: false,
      selected: false,
      source: 'missing',
    };
  }
  return {
    name,
    present: binding.value.trim().length > 0,
    selected: binding.name === activeName && binding.value.trim().length > 0,
    source: binding.source,
    path: binding.path,
    fingerprint: binding.value.trim().length > 0 ? fingerprint(binding.value) : undefined,
    valueLength: binding.value.length,
  };
}

export function inspectGithubToken(options: EnvResolutionOptions = {}): GithubTokenInspection {
  const resolution = resolveEnvBindings([...GITHUB_TOKEN_NAMES], options);
  const activeName = resolution.selected?.name;
  const bindings = GITHUB_TOKEN_NAMES.map((name) => {
    const binding = resolution.bindings[name];
    return toBindingReport(name, binding, activeName);
  });
  const active = bindings.find((binding) => binding.selected);
  const precedenceNote = bindings.filter((binding) => binding.present).length > 1
    ? 'GITHUB_TOKEN takes precedence over GITHUB_PERSONAL_ACCESS_TOKEN when both are present.'
    : undefined;
  return {
    bindings,
    active,
    checkedPaths: resolution.checkedPaths,
    precedenceNote,
  };
}

function parseScopes(value: string | null): string[] {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function extractGithubMessage(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { message?: string };
    return parsed.message?.trim() || undefined;
  } catch {
    const trimmed = body.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}

export async function runGithubTokenCheck(options: EnvResolutionOptions & {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<GithubTokenCheckResult> {
  const resolution = resolveEnvBindings([...GITHUB_TOKEN_NAMES], options);
  const inspection = inspectGithubToken(options);
  const activeBinding = resolution.selected;
  if (!activeBinding || activeBinding.value.trim().length === 0) {
    return {
      ...inspection,
      validation: 'skipped_missing_token',
      scopes: [],
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl('https://api.github.com/user', {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${activeBinding.value}`,
        'User-Agent': 'fieldtheory-cli/github-check',
      },
      signal: controller.signal,
    });
    const scopes = parseScopes(response.headers.get('x-oauth-scopes'));
    const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
    const rateLimitReset = response.headers.get('x-ratelimit-reset');

    if (response.status === 200) {
      const payload = await response.json() as { login?: string };
      return {
        ...inspection,
        validation: 'valid',
        login: payload.login,
        scopes,
        rateLimitRemaining,
        rateLimitReset,
      };
    }

    const message = extractGithubMessage(await response.text());
    if (response.status === 401) {
      return {
        ...inspection,
        validation: 'unauthorized',
        statusCode: 401,
        scopes,
        message,
        rateLimitRemaining,
        rateLimitReset,
      };
    }
    if (response.status === 403) {
      return {
        ...inspection,
        validation: rateLimitRemaining === '0' ? 'rate_limited' : 'forbidden',
        statusCode: 403,
        scopes,
        message,
        rateLimitRemaining,
        rateLimitReset,
      };
    }
    return {
      ...inspection,
      validation: 'http_error',
      statusCode: response.status,
      scopes,
      message,
      rateLimitRemaining,
      rateLimitReset,
    };
  } catch (error) {
    const err = error as Error;
    return {
      ...inspection,
      validation: 'network_error',
      scopes: [],
      message: err.name === 'AbortError'
        ? `Timed out after ${timeoutMs}ms contacting GitHub.`
        : err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
