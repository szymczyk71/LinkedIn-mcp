#!/usr/bin/env node
/**
 * Worker: proces w tle z harmonogramem, bazą i klientem LinkedIn.
 * (Lokalne API na 127.0.0.1 dla nakładki MCP dochodzi w etapie 3.)
 */
import { Scheduler, createCore, createLogger, describeConfig, loadConfig, readPause } from '../core/index.js';
import { InstanceLock } from './instance-lock.js';
import { startScheduler } from './scheduler-runner.js';

const LIVE_BANNER = `
################################################################
#  TRYB LIVE: worker publikuje NAPRAWDĘ na LinkedIn.           #
#  Bezpiecznik: npm run pause   (wyłączenie: npm run resume)   #
################################################################`;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ file: config.paths.workerLogFile });
  const core = createCore(config);
  const lock = InstanceLock.acquire(config.paths.dataDir);

  if (config.mode === 'live') process.stderr.write(LIVE_BANNER + '\n');
  log.info('Worker startuje', { ...describeConfig(config), pid: process.pid, pause: readPause(config.paths.pauseFlagFile) });

  const recovery = await new Scheduler(core, log).recoverOnStartup();
  await core.audit.record('system', 'worker_start', 'ok', null, { mode: config.mode, ...recovery });
  await core.store.close(); // przebiegi otwierają własne połączenia

  const runner = await startScheduler(config, log);
  // Pierwszy przebieg od razu po starcie (polityka "missed" po wyłączonym komputerze).
  await runner.runNow();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('Worker zatrzymuje się', { signal });
    await runner.stop();
    lock.release();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  process.on('exit', () => lock.release());
}

main().catch((e: unknown) => {
  process.stderr.write(`Worker nie wystartował: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
