/**
 * Zadanie Bree uruchamiane w osobnym wątku co SCHEDULER_INTERVAL_MIN minut.
 * Każdy przebieg otwiera własne połączenie z bazą; spójność zapewniają warunkowe przejścia statusów.
 */
import { parentPort } from 'node:worker_threads';
import { Scheduler, createCore, createLogger, loadConfig } from '../core/index.js';

const config = loadConfig();
const log = createLogger({ file: config.paths.workerLogFile, stderr: process.env.LINKEDIN_MCP_DETACHED !== '1' });
const core = createCore(config);

try {
  const result = await new Scheduler(core, log).tick();
  const busy =
    result.published.length + result.missed.length + result.failed.length + result.commentsDone.length + result.commentsSkipped.length + result.commentsFailed.length;
  if (busy > 0 || result.paused) log.info('Przebieg harmonogramu', { ...result });
  parentPort?.postMessage({ type: 'tick', result });
} catch (e) {
  log.error('Błąd przebiegu harmonogramu', { error: e instanceof Error ? e.message : String(e) });
  parentPort?.postMessage({ type: 'tick_error', error: e instanceof Error ? e.message : String(e) });
} finally {
  await core.store.close();
}
