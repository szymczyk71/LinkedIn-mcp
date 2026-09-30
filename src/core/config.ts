import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Katalog główny pakietu (działa zarówno z src/, jak i z dist/). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Jedyny dozwolony adres nasłuchu. */
export const LOOPBACK_HOST = '127.0.0.1';

const intFromEnv = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  LINKEDIN_MODE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'mock' : v.trim().toLowerCase()))
    .pipe(z.enum(['mock', 'live'])),
  LINKEDIN_MCP_DATA_DIR: optionalString,
  WORKER_PORT: intFromEnv(47811, 1024, 65535),
  DEFAULT_TIMEZONE: optionalString,
  MIN_LEAD_MIN: intFromEnv(5, 5, 24 * 60),
  MISSED_GRACE_MIN: intFromEnv(60, 0, 24 * 60),
  PLAN_TTL_MIN: intFromEnv(30, 1, 24 * 60),
  POST_MAX_CHARS: intFromEnv(3000, 1, 100_000),
  COMMENT_DELAY_DEFAULT_MIN: intFromEnv(10, 0, 24 * 60),
  LINKEDIN_CLIENT_ID: optionalString,
  LINKEDIN_CLIENT_SECRET: optionalString,
  LINKEDIN_REDIRECT_URI: optionalString,
  LINKEDIN_API_VERSION: optionalString,
  LINKEDIN_MCP_ENC_KEY: optionalString,
  HTTP_PORT: intFromEnv(8080, 1, 65535),
  MCP_HTTP_TOKEN: optionalString,
});

export type LinkedInMode = 'mock' | 'live';

export interface Paths {
  dataDir: string;
  dbFile: string;
  auditLogFile: string;
  pauseFlagFile: string;
  workerTokenFile: string;
  tokenStoreFile: string;
  mockStateFile: string;
  mockScenarioFile: string;
  workerLogFile: string;
}

export interface Config {
  mode: LinkedInMode;
  paths: Paths;
  workerHost: typeof LOOPBACK_HOST;
  workerPort: number;
  defaultTimezone: string;
  minLeadMin: number;
  missedGraceMin: number;
  planTtlMin: number;
  postMaxChars: number;
  commentDelayDefaultMin: number;
  linkedin: {
    clientId?: string;
    clientSecret?: string;
    redirectUri: string;
    apiVersion?: string;
  };
  encKeyFromEnv?: string;
  http: { port: number; token?: string };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function defaultDataDir(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'linkedin-mcp');
}

export function buildPaths(dataDir: string): Paths {
  return {
    dataDir,
    dbFile: path.join(dataDir, 'linkedin-mcp.db'),
    auditLogFile: path.join(dataDir, 'audit.jsonl'),
    pauseFlagFile: path.join(dataDir, 'PAUSE'),
    workerTokenFile: path.join(dataDir, 'worker-token'),
    tokenStoreFile: path.join(dataDir, 'linkedin-tokens.enc'),
    mockStateFile: path.join(dataDir, 'mock-linkedin.json'),
    mockScenarioFile: path.join(dataDir, 'mock-scenario.json'),
    workerLogFile: path.join(dataDir, 'worker.log'),
  };
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Ładuje konfigurację: najpierw plik .env (LINKEDIN_MCP_ENV_FILE albo .env w katalogu pakietu),
 * potem zmienne środowiskowe procesu (mają pierwszeństwo).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { envFile?: string | false } = {}): Config {
  let merged: Record<string, string | undefined> = { ...env };
  const envFile = opts.envFile === false ? undefined : (opts.envFile ?? env.LINKEDIN_MCP_ENV_FILE ?? path.join(PACKAGE_ROOT, '.env'));
  if (envFile && fs.existsSync(envFile)) {
    const fromFile = dotenv.parse(fs.readFileSync(envFile));
    merged = { ...fromFile, ...env };
  }

  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Niepoprawna konfiguracja: ${issues}`);
  }
  const e = parsed.data;

  const dataDir = path.resolve(e.LINKEDIN_MCP_DATA_DIR ?? defaultDataDir());
  if (isInside(dataDir, PACKAGE_ROOT)) {
    throw new ConfigError(`Katalog danych (${dataDir}) nie może leżeć w repozytorium (${PACKAGE_ROOT}).`);
  }

  const tz = e.DEFAULT_TIMEZONE ?? 'Europe/Warsaw';
  if (!isValidTimezone(tz)) throw new ConfigError(`Nieznana strefa czasowa DEFAULT_TIMEZONE: ${tz}`);

  if (e.LINKEDIN_MCP_ENC_KEY !== undefined && Buffer.from(e.LINKEDIN_MCP_ENC_KEY, 'base64').length !== 32) {
    throw new ConfigError('LINKEDIN_MCP_ENC_KEY musi być 32-bajtowym kluczem zakodowanym w base64.');
  }

  return {
    mode: e.LINKEDIN_MODE,
    paths: buildPaths(dataDir),
    workerHost: LOOPBACK_HOST,
    workerPort: e.WORKER_PORT,
    defaultTimezone: tz,
    minLeadMin: e.MIN_LEAD_MIN,
    missedGraceMin: e.MISSED_GRACE_MIN,
    planTtlMin: e.PLAN_TTL_MIN,
    postMaxChars: e.POST_MAX_CHARS,
    commentDelayDefaultMin: e.COMMENT_DELAY_DEFAULT_MIN,
    linkedin: {
      clientId: e.LINKEDIN_CLIENT_ID,
      clientSecret: e.LINKEDIN_CLIENT_SECRET,
      redirectUri: e.LINKEDIN_REDIRECT_URI ?? `http://${LOOPBACK_HOST}:${e.WORKER_PORT}/oauth/callback`,
      apiVersion: e.LINKEDIN_API_VERSION,
    },
    encKeyFromEnv: e.LINKEDIN_MCP_ENC_KEY,
    http: { port: e.HTTP_PORT, token: e.MCP_HTTP_TOKEN },
  };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function ensureDataDir(paths: Paths): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
}

/** Opis konfiguracji do logów i komendy status. Nigdy nie zawiera sekretów. */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    mode: c.mode,
    dataDir: c.paths.dataDir,
    dbFile: c.paths.dbFile,
    worker: `http://${c.workerHost}:${c.workerPort}`,
    defaultTimezone: c.defaultTimezone,
    minLeadMin: c.minLeadMin,
    missedGraceMin: c.missedGraceMin,
    planTtlMin: c.planTtlMin,
    postMaxChars: c.postMaxChars,
    commentDelayDefaultMin: c.commentDelayDefaultMin,
    linkedinClientConfigured: Boolean(c.linkedin.clientId && c.linkedin.clientSecret),
    redirectUri: c.linkedin.redirectUri,
    encKeySource: c.encKeyFromEnv ? 'env' : 'windows-credential-manager',
  };
}
