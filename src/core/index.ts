import { AuditLog } from './audit.js';
import { ensureDataDir, type Config } from './config.js';
import { SqliteStore } from './db/sqlite-store.js';
import type { Store } from './db/store.js';
import { createLinkedInClient, type LinkedInClient } from './linkedin/index.js';
import { systemClock, type Clock } from './util.js';

export * from './config.js';
export * from './model.js';
export * from './util.js';
export * from './audit.js';
export * from './pause.js';
export * from './time.js';
export * from './posts.js';
export * from './logger.js';
export * from './scheduler.js';
export * from './db/store.js';
export { SqliteStore } from './db/sqlite-store.js';
export * from './linkedin/index.js';

/** Wszystko, czego potrzebują punkty wejścia (worker, server-http, CLI). */
export interface CoreContext {
  config: Config;
  store: Store;
  audit: AuditLog;
  linkedin: LinkedInClient;
  clock: Clock;
}

export function createCore(
  config: Config,
  overrides: Partial<Pick<CoreContext, 'store' | 'linkedin' | 'clock'>> & { auditFile?: string | null } = {},
): CoreContext {
  ensureDataDir(config.paths);
  const clock = overrides.clock ?? systemClock;
  const store = overrides.store ?? new SqliteStore(config.paths.dbFile);
  const linkedin = overrides.linkedin ?? createLinkedInClient(config);
  const auditFile = overrides.auditFile === undefined ? config.paths.auditLogFile : overrides.auditFile;
  const audit = new AuditLog(store, auditFile, clock);
  return { config, store, audit, linkedin, clock };
}
