/**
 * Zadanie Bree (server-http): przebieg harmonogramu na PostgreSQL, sprzątanie danych OAuth i biletów przesyłania,
 * alerty o wygasających logowaniach i raz dziennie ponowne sprawdzenie ról administratorów na stronie firmy.
 * Zdarzenia do alertów (Azure Monitor) są logowane jako JSON z polem "alert".
 */
import { parentPort } from 'node:worker_threads';
import { AccessDenied, Scheduler, createLogger, fetchMemberIdentity, loadConfig, resolveAccess } from '../core/index.js';
import { openServerCore } from './core.js';

const config = loadConfig();
const log = createLogger({ json: true });
const core = await openServerCore(config);

try {
  const result = await new Scheduler(core, log).tick();
  await core.db.deleteExpiredServerData(result.at);
  for (const id of result.failed) log.error('Publikacja nie powiodła się', { alert: 'publish_failed', postId: id });
  for (const id of result.missed) log.warn('Post pominięty (missed)', { alert: 'post_missed', postId: id });

  const now = new Date();
  const firstTickOfHour = now.getUTCMinutes() < config.schedulerIntervalMin;
  if (config.mode === 'live' && firstTickOfHour) {
    const team = (await core.accounts.list()).filter((a) => a.status === 'active');
    const valid = team.filter((a) => a.tokenPresent && a.expiresAt && a.expiresAt > now.toISOString());
    if (!valid.length) log.error('Żaden administrator nie ma ważnego logowania LinkedIn', { alert: 'no_valid_login' });
    for (const a of valid) {
      const days = Math.floor((Date.parse(a.expiresAt!) - now.getTime()) / 86_400_000);
      if (days <= 7) log.warn('Logowanie LinkedIn wkrótce wygaśnie', { alert: 'linkedin_login_expiring', person: a.name ?? a.personUrn, daysLeft: days });
    }
    // Raz dziennie (03:00 UTC): czy każda osoba nadal ma dozwoloną rolę na stronie firmy.
    if (now.getUTCHours() === 3) {
      for (const a of valid) {
        const rec = await core.accounts.get(a.personUrn).catch(() => null);
        if (!rec) continue;
        try {
          const access = resolveAccess(config, await fetchMemberIdentity(config, rec.accessToken));
          await core.accounts.setVerified(a.personUrn, 'active', access.roles, now.toISOString());
        } catch (e) {
          if (e instanceof AccessDenied) {
            await core.accounts.setVerified(a.personUrn, 'revoked', [], now.toISOString());
            await core.audit.record('system', 'access_revoked', 'rejected', a.personUrn, { reason: e.message });
            log.warn('Odebrano dostęp: brak dozwolonej roli na stronie', { alert: 'access_revoked', person: a.name ?? a.personUrn });
          }
        }
      }
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
