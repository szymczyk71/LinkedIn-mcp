import { AuditLog } from '../core/audit.js';
import { ConfigError, type Config } from '../core/config.js';
import { PostgresStore } from '../core/db/pg-store.js';
import { DbImageRepo, DbPause, DbSecret, DbUploadRegistry } from '../core/db/server-backends.js';
import type { CoreContext } from '../core/index.js';
import { createLinkedInClient } from '../core/linkedin/index.js';
import type { LinkedInClient } from '../core/linkedin/client.js';
import { EnvOrKeyringKeyProvider, TokenStore } from '../core/token-store.js';
import { systemClock, type Clock } from '../core/util.js';

export interface ServerCore extends CoreContext {
  db: PostgresStore;
  publicBaseUrl: string;
}

export interface ServerCoreOptions {
  clock?: Clock;
  linkedin?: LinkedInClient;
  /** Schemat PostgreSQL (izolacja w testach). */
  pgSchema?: string;
}

/** Wymagania wariantu server-http - sprawdzane przy starcie, żeby błąd był czytelny. */
export function requireServerConfig(config: Config): { databaseUrl: string; publicBaseUrl: string } {
  const missing: string[] = [];
  if (!config.http.databaseUrl) missing.push('DATABASE_URL');
  if (!config.http.publicBaseUrl) missing.push('PUBLIC_BASE_URL');
  if (!config.encKeyFromEnv) missing.push('LINKEDIN_MCP_ENC_KEY (w chmurze nie ma Menedżera poświadczeń Windows)');
  if (!config.linkedin.clientId || !config.linkedin.clientSecret) missing.push('LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET');
  if (missing.length) throw new ConfigError(`server-http wymaga ustawień: ${missing.join(', ')}.`);
  return { databaseUrl: config.http.databaseUrl!, publicBaseUrl: config.http.publicBaseUrl! };
}

/** Kontekst wariantu server-http: wszystko w PostgreSQL (kolejka, obrazy, token LinkedIn, bezpiecznik, OAuth). */
export async function openServerCore(config: Config, opts: ServerCoreOptions = {}): Promise<ServerCore> {
  const { databaseUrl, publicBaseUrl } = requireServerConfig(config);
  const db = await PostgresStore.connect(databaseUrl, { schema: opts.pgSchema });
  const clock = opts.clock ?? systemClock;
  const tokens = new TokenStore(new DbSecret(db, 'linkedin_token'), new EnvOrKeyringKeyProvider(config.encKeyFromEnv));
  const linkedin = opts.linkedin ?? createLinkedInClient(config, tokens);
  return {
    config,
    store: db,
    db,
    publicBaseUrl,
    // W kontenerze dziennik idzie na stdout (Azure Monitor), a audyt do bazy.
    audit: new AuditLog(db, null, clock),
    linkedin,
    clock,
    images: new DbImageRepo(db),
    pause: new DbPause(db),
    tokens,
    uploads: new DbUploadRegistry(db, publicBaseUrl),
  };
}
