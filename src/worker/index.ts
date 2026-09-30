#!/usr/bin/env node
/**
 * Worker: proces w tle z harmonogramem (Bree), bazą, klientem LinkedIn
 * i lokalnym API na 127.0.0.1 dla nakładki MCP (mcp-stdio).
 */
import { Scheduler, createCore, createLogger, describeConfig, loadConfig, readPause } from '../core/index.js';
import { ensureWorkerToken } from '../core/worker-token.js';
import { startApi } from './api.js';
import { InstanceLock } from './instance-lock.js';
import { startScheduler } from './scheduler-runner.js';

const LIVE_BANNER = `
################################################################
#  TRYB LIVE: worker publikuje NAPRAWDĘ na LinkedIn.           #
#  Bezpiecznik: npm run pause   (wyłączenie: npm run resume)   #
################################################################`;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ file: config.paths.workerLogFile, stderr: process.env.LINKEDIN_MCP_DETACHED !== '1' });
  const core = createCore(config);
  const lock = InstanceLock.acquire(config.paths.dataDir);

  if (config.mode === 'live') process.stderr.write(LIVE_BANNER + '\n');
  log.info('Worker startuje', { ...describeConfig(config), pid: process.pid, pause: readPause(config.paths.pauseFlagFile) });

  const recovery = await new Scheduler(core, log).recoverOnStartup();
  await core.audit.record('system', 'worker_start', 'ok', null, { mode: config.mode, ...recovery });

  const token = ensureWorkerToken(config.paths.workerTokenFile);
  let shutdownRequested: () => void = () => {};
  let api;
  try {
    api = await startApi(core, token, log, config.workerPort, () => shutdownRequested());
  } catch (e) {
    lock.release();
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'EADDRINUSE'
        ? `Port ${config.workerPort} na 127.0.0.1 jest zajęty. Zmień WORKER_PORT w .env albo zamknij program, który go używa.`
        : `Nie udało się uruchomić lokalnego API: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const runner = await startScheduler(config, log);
  // Pierwszy przebieg od razu po starcie (polityka "missed" po wyłączonym komputerze).
  await runner.runNow();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('Worker zatrzymuje się', { signal });
    await runner.stop();
    await api.close();
    await core.store.close();
    lock.release();
    process.exit(0);
  };
  shutdownRequested = () => void shutdown('api');
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  process.on('exit', () => lock.release());
}

main().catch((e: unknown) => {
  process.stderr.write(`Worker nie wystartował: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
