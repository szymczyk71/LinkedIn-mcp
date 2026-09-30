/**
 * Zadanie Bree (server-http): przebieg harmonogramu na PostgreSQL + sprzątanie danych OAuth i biletów przesyłania.
 * Zdarzenia do alertów (Azure Monitor) są logowane jako JSON z polem "alert".
 */
import { parentPort } from 'node:worker_threads';
import { Scheduler, createLogger, loadConfig } from '../core/index.js';
import { openServerCore } from './core.js';

const config = loadConfig();
const log = createLogger({ json: true });
const core = await openServerCore(config);

try {
  const result = await new Scheduler(core, log).tick();
  await core.db.deleteExpiredServerData(result.at);
  for (const id of result.failed) log.error('Publikacja nie powiodła się', { alert: 'publish_failed', postId: id });
  for (const id of result.missed) log.warn('Post pominięty (missed)', { alert: 'post_missed', postId: id });

  const tok = await core.tokens.info();
  if (config.mode === 'live' && tok.expiresAt) {
    const days = Math.floor((Date.parse(tok.expiresAt) - Date.now()) / 86_400_000);
    // Raz na godzinę wystarczy do alertu (przebiegi co 5 min).
    if (days <= 7 && new Date().getUTCMinutes() < config.schedulerIntervalMin) {
      log.warn('Logowanie LinkedIn wkrótce wygaśnie', { alert: 'linkedin_login_expiring', daysLeft: days, expiresAt: tok.expiresAt });
    }
  }
  const busy = result.published.length + result.missed.length + result.failed.length + result.commentsDone.length + result.commentsSkipped.length + result.commentsFailed.length;
  if (busy > 0 || result.paused) log.info('Przebieg harmonogramu', { ...result });
  parentPort?.postMessage({ type: 'tick', result });
} catch (e) {
  log.error('Błąd przebiegu harmonogramu', { alert: 'scheduler_error', error: e instanceof Error ? e.message : String(e) });
} finally {
  await core.db.close();
}
