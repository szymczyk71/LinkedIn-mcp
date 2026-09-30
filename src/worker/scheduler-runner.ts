import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Bree from 'bree';
import type { Config, Logger, TickResult } from '../core/index.js';

const JOB_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tick-job.js');

export interface SchedulerRunner {
  runNow(): Promise<void>;
  stop(): Promise<void>;
  readonly lastTick: TickResult | null;
}

/**
 * Bree uruchamia przebieg co `schedulerIntervalMin` minut, wyrównany do zegara (cron * /N).
 * Bree nie startuje zadania, które jeszcze trwa, więc przebiegi się nie nakładają.
 */
export async function startScheduler(config: Config, log: Logger, onTick?: (r: TickResult) => void): Promise<SchedulerRunner> {
  let lastTick: TickResult | null = null;
  const bree = new Bree({
    root: false,
    doRootCheck: false,
    logger: {
      info: () => {},
      warn: (...a: unknown[]) => log.warn('Bree', { detail: a.map(String).join(' ') }),
      error: (...a: unknown[]) => log.error('Bree', { detail: a.map(String).join(' ') }),
    } as unknown as Bree.BreeLogger,
    jobs: [{ name: 'tick', path: JOB_FILE, cron: `*/${config.schedulerIntervalMin} * * * *` }],
    workerMessageHandler: ({ message }: { message: unknown }) => {
      const m = message as { type?: string; result?: TickResult; error?: string };
      if (m?.type === 'tick' && m.result) {
        lastTick = m.result;
        onTick?.(m.result);
      }
    },
    errorHandler: (error: unknown) => log.error('Błąd zadania harmonogramu', { error: String(error) }),
  });
  await bree.start();
  log.info('Harmonogram uruchomiony', { intervalMin: config.schedulerIntervalMin });

  return {
    runNow: () => bree.run('tick'),
    stop: () => bree.stop(),
    get lastTick() {
      return lastTick;
    },
  };
}
