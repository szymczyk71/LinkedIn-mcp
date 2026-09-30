import { AuditLog } from '../core/audit.js';
import type { Config } from '../core/config.js';
import { PostgresStore } from '../core/db/pg-store.js';
import { DbPause } from '../core/db/server-backends.js';
import { formatLocal } from '../core/time.js';

/**
 * Administracja wariantem server-http (baza PostgreSQL w Azure). Wymaga DATABASE_URL w .env albo w zmiennej
 * środowiskowej - np. uruchomione z własnego komputera z dostępem do bazy albo w konsoli kontenera.
 */
async function open(config: Config): Promise<PostgresStore> {
  if (!config.http.databaseUrl) throw new Error('Brak DATABASE_URL - komendy "server" działają na bazie wariantu server-http.');
  return PostgresStore.connect(config.http.databaseUrl);
}

export async function serverCommand(config: Config, sub: string | undefined, args: string[]): Promise<Record<string, unknown>> {
  const db = await open(config);
  const audit = new AuditLog(db, null);
  try {
    const pause = new DbPause(db);
    switch (sub) {
      case 'pause': {
        const info = await pause.set(args.join(' ') || null);
        await audit.record('cli', 'pause', 'ok', null, { reason: info.reason, target: 'server' });
        return { ...info, message: 'Bezpiecznik serwera włączony: harmonogram nie opublikuje niczego do "server resume".' };
      }
      case 'resume': {
        const info = await pause.clear();
        await audit.record('cli', 'resume', 'ok', null, { target: 'server' });
        return { ...info, message: 'Bezpiecznik serwera wyłączony.' };
      }
      case 'owner-reset': {
        if (!args.includes('--yes')) {
          return { reset: false, message: 'Reset odłącza właściciela, unieważnia tokeny konektora i usuwa token LinkedIn. Powtórz z --yes.' };
        }
        const now = new Date().toISOString();
        await db.setSetting('owner_person_urn', null, now);
        const revoked = await db.revokeAllTokens(now);
        await db.deleteSecret('linkedin_token');
        await db.setAuthMeta('live', null);
        await audit.record('cli', 'owner_reset', 'ok', null, { revoked });
        return { reset: true, revokedTokens: revoked, message: 'Właściciel odłączony. Następne konto, które połączy konektor, zostanie właścicielem.' };
      }
      case 'status':
      default: {
        const counts: Record<string, number> = {};
        for (const p of await db.listPosts({ limit: 100_000 })) counts[p.status] = (counts[p.status] ?? 0) + 1;
        const next = (await db.listPosts({ status: 'scheduled', fromUtc: new Date().toISOString(), limit: 5 })).map((p) => ({
          id: p.id,
          publish_at_local: formatLocal(p.publishAtUtc, p.timezone),
          text_start: [...p.text].slice(0, 60).join(''),
        }));
        const live = await db.getAuthMeta('live');
        return {
          owner: await db.getSetting('owner_person_urn'),
          linkedin_login: { present: Boolean(await db.getSecret('linkedin_token')), profile_name: live?.profileName ?? null, expires_at: live?.expiresAt ?? null, can_comment: live?.canComment ?? 'unknown' },
          pause: await pause.read(),
          posts: counts,
          next_scheduled: next,
        };
      }
    }
  } finally {
    await db.close();
  }
}
