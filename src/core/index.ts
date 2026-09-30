import { AuditLog } from './audit.js';
import { ensureDataDir, type Config } from './config.js';
import { SqliteStore } from './db/sqlite-store.js';
import type { Store } from './db/store.js';
import { FileImageRepo, type ImageRepo } from './image.js';
import { createLinkedInClient, createTokenStore, type LinkedInClient } from './linkedin/index.js';
import { FilePause, type PauseBackend } from './pause.js';
import type { TokenStore } from './token-store.js';
import type { UploadRegistry } from './uploads.js';
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
export * from './image.js';
export * from './little.js';
export * from './token-store.js';
export * from './service.js';
export * from './worker-token.js';
export * from './uploads.js';
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
  /** Zatwierdzone kopie obrazów (pliki lokalnie, baza w server-http). */
  images: ImageRepo;
  /** Bezpiecznik (plik PAUSE lokalnie, wpis w bazie w server-http). */
  pause: PauseBackend;
  /** Zaszyfrowany token LinkedIn. */
  tokens: TokenStore;
  /** Przesyłanie zdjęć przez jednorazowy link (tylko server-http). */
  uploads?: UploadRegistry;
}

export type CoreOverrides = Partial<Pick<CoreContext, 'store' | 'linkedin' | 'clock' | 'images' | 'pause' | 'tokens'>> & {
  auditFile?: string | null;
};

/** Kontekst trybu lokalnego (SQLite + pliki w katalogu danych). */
export function createCore(config: Config, overrides: CoreOverrides = {}): CoreContext {
  ensureDataDir(config.paths);
  const clock = overrides.clock ?? systemClock;
  const store = overrides.store ?? new SqliteStore(config.paths.dbFile);
  const tokens = overrides.tokens ?? createTokenStore(config);
  const linkedin = overrides.linkedin ?? createLinkedInClient(config, tokens);
  const auditFile = overrides.auditFile === undefined ? config.paths.auditLogFile : overrides.auditFile;
  const audit = new AuditLog(store, auditFile, clock);
  const images = overrides.images ?? new FileImageRepo(config.paths.imagesDir);
  const pause = overrides.pause ?? new FilePause(config.paths.pauseFlagFile);
  return { config, store, audit, linkedin, clock, images, pause, tokens };
}
