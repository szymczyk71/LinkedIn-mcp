#!/usr/bin/env node
/**
 * Wariant server-http: wszystko w jednym procesie - MCP przez Streamable HTTP (konektor Claude z OAuth),
 * harmonogram Bree, PostgreSQL. Przeznaczony do kontenera (Azure Container Apps, 1 replika).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scheduler, createLogger, describeConfig, loadConfig } from '../core/index.js';
import { startScheduler } from '../worker/scheduler-runner.js';
import { startHttpApp } from './app.js';
import { openServerCore } from './core.js';

const TICK_JOB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tick-job.js');

const LIVE_BANNER = 'TRYB LIVE: serwer publikuje NAPRAWDĘ na LinkedIn. Bezpiecznik: npm run pause (z DATABASE_URL).';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ json: true });
  const core = await openServerCore(config);
  if (config.mode === 'live') log.warn(LIVE_BANNER, { alert: 'live_mode' });
  log.info('server-http startuje', { ...describeConfig(config), publicBaseUrl: core.publicBaseUrl, pause: await core.pause.read() });

  const recovery = await new Scheduler(core, log).recoverOnStartup();
  await core.audit.record('system', 'server_start', 'ok', null, { mode: config.mode, ...recovery });

  const app = await startHttpApp(core, log);
  const runner = await startScheduler(config, log, undefined, TICK_JOB);
  await runner.runNow();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('server-http zatrzymuje się', { signal });
    await runner.stop();
    await app.close();
    await core.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  process.stderr.write(`server-http nie wystartował: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
