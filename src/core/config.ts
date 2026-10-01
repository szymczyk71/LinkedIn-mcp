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
  IMAGE_MAX_MB: intFromEnv(10, 1, 200),
  SCHEDULER_INTERVAL_MIN: intFromEnv(5, 1, 30).refine((n) => 60 % n === 0, {
    message: 'musi być dzielnikiem 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30)',
  }),
  LINKEDIN_CLIENT_ID: optionalString,
  LINKEDIN_CLIENT_SECRET: optionalString,
  LINKEDIN_REDIRECT_URI: optionalString,
  LINKEDIN_API_VERSION: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? '202609' : v.trim()))
    .pipe(z.string().regex(/^\d{6}$/, 'format RRRRMM, np. 202609')),
  /** Numer strony firmy (z adresu linkedin.com/company/<numer>/admin). Posty wychodzą w jej imieniu. */
  LINKEDIN_ORGANIZATION_ID: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .pipe(z.string().regex(/^\d+$/, 'sam numer strony, np. 12345678').optional()),
  /** Nazwa strony do wyświetlania (np. KTBnet) - tylko opisowo. */
  LINKEDIN_ORGANIZATION_NAME: optionalString,
  /** Role na stronie firmy, które pozwalają korzystać z planera. */
  LINKEDIN_ALLOWED_ROLES: optionalString,
  LINKEDIN_SCOPES: optionalString,
  /** Tylko do testów: podmiana adresów LinkedIn na lokalną atrapę HTTP. */
  LINKEDIN_API_BASE: optionalString,
  LINKEDIN_OAUTH_BASE: optionalString,
  LINKEDIN_MCP_ENC_KEY: optionalString,
  HTTP_PORT: intFromEnv(8080, 1, 65535),
  /** server-http: adres nasłuchu. Lokalnie 127.0.0.1; w kontenerze (Azure) 0.0.0.0 za bramą HTTPS. */
  HTTP_HOST: optionalString,
  /** server-http: publiczny adres HTTPS aplikacji, np. https://linkedin-mcp.xxx.azurecontainerapps.io */
  PUBLIC_BASE_URL: optionalString,
  /** server-http: PostgreSQL, np. postgres://user:pass@host:5432/db?sslmode=require */
  DATABASE_URL: optionalString,
  MCP_ACCESS_TOKEN_TTL_MIN: intFromEnv(60, 5, 24 * 60),
  /** Dodatkowe dozwolone adresy zwrotne klientów OAuth (oprócz Claude i loopback), oddzielone przecinkami. */
  OAUTH_EXTRA_REDIRECT_URIS: optionalString,
  RATE_LIMIT_PER_MIN: intFromEnv(120, 10, 10_000),
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
  imagesDir: string;
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
  /** Co ile minut działa przebieg harmonogramu (wyrównany do zegara: :00, :05, ...). */
  schedulerIntervalMin: number;
  /** Maksymalny rozmiar obrazu dołączanego do posta (bajty). */
  imageMaxBytes: number;
  linkedin: {
    clientId?: string;
    clientSecret?: string;
    redirectUri: string;
    apiVersion: string;
    organizationId: string | null;
    organizationName: string | null;
    allowedRoles: string[];
    scopes: string[];
    apiBase: string;
    oauthBase: string;
  };
  encKeyFromEnv?: string;
  http: {
    port: number;
    host: string;
    publicBaseUrl: string | null;
    databaseUrl: string | null;
    accessTokenTtlMin: number;
    extraRedirectUris: string[];
    rateLimitPerMin: number;
  };
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
    imagesDir: path.join(dataDir, 'images'),
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

  let publicBaseUrl: string | null = null;
  if (e.PUBLIC_BASE_URL) {
    let u: URL;
    try {
      u = new URL(e.PUBLIC_BASE_URL);
    } catch {
      throw new ConfigError(`PUBLIC_BASE_URL nie jest poprawnym adresem: ${e.PUBLIC_BASE_URL}`);
    }
    const loopback = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !loopback) throw new ConfigError('PUBLIC_BASE_URL musi używać https:// (wyjątek: localhost do testów).');
    if (u.pathname !== '/' || u.search || u.hash) throw new ConfigError('PUBLIC_BASE_URL to sam adres bez ścieżki, np. https://moja-aplikacja.azurecontainerapps.io');
    publicBaseUrl = u.origin;
  }
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
    schedulerIntervalMin: e.SCHEDULER_INTERVAL_MIN,
    imageMaxBytes: e.IMAGE_MAX_MB * 1_048_576,
    linkedin: {
      clientId: e.LINKEDIN_CLIENT_ID,
      clientSecret: e.LINKEDIN_CLIENT_SECRET,
      redirectUri:
        e.LINKEDIN_REDIRECT_URI ??
        (publicBaseUrl ? `${publicBaseUrl}/oauth/callback` : `http://${LOOPBACK_HOST}:${e.WORKER_PORT}/oauth/callback`),
      apiVersion: e.LINKEDIN_API_VERSION,
      organizationId: e.LINKEDIN_ORGANIZATION_ID ?? null,
      organizationName: e.LINKEDIN_ORGANIZATION_NAME ?? null,
      allowedRoles: (e.LINKEDIN_ALLOWED_ROLES ?? 'ADMINISTRATOR,CONTENT_ADMINISTRATOR')
        .split(/[\s,]+/)
        .map((r) => r.trim().toUpperCase())
        .filter(Boolean),
      scopes: (e.LINKEDIN_SCOPES ?? 'r_organization_admin w_organization_social').split(/[\s,]+/).filter(Boolean),
      apiBase: (e.LINKEDIN_API_BASE ?? 'https://api.linkedin.com').replace(/\/$/, ''),
      oauthBase: (e.LINKEDIN_OAUTH_BASE ?? 'https://www.linkedin.com').replace(/\/$/, ''),
    },
    encKeyFromEnv: e.LINKEDIN_MCP_ENC_KEY,
    http: {
      port: e.HTTP_PORT,
      host: e.HTTP_HOST ?? LOOPBACK_HOST,
      publicBaseUrl,
      databaseUrl: e.DATABASE_URL ?? null,
      accessTokenTtlMin: e.MCP_ACCESS_TOKEN_TTL_MIN,
      extraRedirectUris: (e.OAUTH_EXTRA_REDIRECT_URIS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      rateLimitPerMin: e.RATE_LIMIT_PER_MIN,
    },
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
    schedulerIntervalMin: c.schedulerIntervalMin,
    linkedinClientConfigured: Boolean(c.linkedin.clientId && c.linkedin.clientSecret),
    redirectUri: c.linkedin.redirectUri,
    apiVersion: c.linkedin.apiVersion,
    organizationId: c.linkedin.organizationId,
    allowedRoles: c.linkedin.allowedRoles.join(','),
    scopes: c.linkedin.scopes.join(' '),
    encryptionKeyStore: c.encKeyFromEnv ? 'env' : 'windows-credential-manager',
  };
}
