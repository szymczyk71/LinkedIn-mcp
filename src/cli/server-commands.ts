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
      case 'users': {
        const [action, who] = args;
        const users = await db.listUsers();
        if (!action || action === 'list') {
          return {
            users: users.map((u) => ({ name: u.name, person_urn: u.personUrn, roles: u.roles, status: u.status, last_login_at: u.lastLoginAt, last_verified_at: u.lastVerifiedAt })),
          };
        }
        const target = users.find((u) => u.personUrn === who || (who && u.name?.toLowerCase() === who.toLowerCase()));
        if (!target) throw new Error(`Nie ma użytkownika "${who ?? ''}". Lista: npm run cli -- server users list`);
        const now = new Date().toISOString();
        if (action === 'block') {
          await db.setUserStatus(target.personUrn, 'blocked', null, now);
          const revoked = await db.revokeTokensForPerson(target.personUrn, now);
          await audit.record('cli', 'user_blocked', 'ok', target.personUrn, { revoked });
          return { blocked: true, user: target.name ?? target.personUrn, revokedTokens: revoked, message: 'Konto zablokowane - konektor przestanie działać dla tej osoby, a jej token nie będzie używany do publikacji.' };
        }
        if (action === 'unblock') {
          await db.setUserStatus(target.personUrn, 'revoked', null, now);
          await audit.record('cli', 'user_unblocked', 'ok', target.personUrn, null);
          return { unblocked: true, user: target.name ?? target.personUrn, message: 'Odblokowano. Osoba musi połączyć konektor ponownie (role zostaną sprawdzone w LinkedIn).' };
        }
        if (action === 'remove') {
          if (!args.includes('--yes')) return { removed: false, message: 'Usunięcie kasuje konto i token tej osoby. Powtórz z --yes.' };
          await db.revokeTokensForPerson(target.personUrn, now);
          await db.deleteSecret(`linkedin_token:${target.personUrn}`);
          await db.deleteUser(target.personUrn);
          await audit.record('cli', 'user_removed', 'ok', target.personUrn, null);
          return { removed: true, user: target.name ?? target.personUrn };
        }
        throw new Error('Użycie: server users list | block <osoba> | unblock <osoba> | remove <osoba> --yes');
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
          organization_urn: config.linkedin.organizationId ? `urn:li:organization:${config.linkedin.organizationId}` : null,
          users: (await db.listUsers()).map((u) => ({ name: u.name ?? u.personUrn, roles: u.roles, status: u.status, last_login_at: u.lastLoginAt })),
          can_comment: live?.canComment ?? 'unknown',
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
