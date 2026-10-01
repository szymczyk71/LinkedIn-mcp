import type { Config } from '../core/config.js';
import { SqliteStore } from '../core/db/sqlite-store.js';
import { AuditLog } from '../core/audit.js';
import { LiveLinkedIn } from '../core/linkedin/live.js';
import { SingleAccount } from '../core/accounts.js';
import { buildTokenRecord, createTokenStore, fetchMemberIdentity, organizationUrnFromConfig, resolveAccess, saveLogin } from '../core/linkedin/oauth.js';
import { formatLocal } from '../core/time.js';

/** Czyta sekret: z potoku (stdin) albo z klawiatury bez wyświetlania znaków. */
export async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          cleanup();
          return reject(new Error('Przerwano.'));
        }
        if (ch === '\u0008' || ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

export async function tokenImport(config: Config, args: string[]): Promise<Record<string, unknown>> {
  const daysIdx = args.indexOf('--expires-in-days');
  const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 60;
  if (!Number.isFinite(days) || days <= 0 || days > 366) throw new Error('--expires-in-days musi być liczbą dni (1-366).');
  const scopesIdx = args.indexOf('--scopes');
  const scopes = (scopesIdx >= 0 ? (args[scopesIdx + 1] ?? '') : config.linkedin.scopes.join(' ')).split(/[\s,]+/).filter(Boolean);

  const token = await readSecret('Wklej token dostępu z LinkedIn Developer Portal (nie będzie widoczny) i naciśnij Enter: ');
  if (token.length < 20) throw new Error('To nie wygląda na token dostępu (za krótki).');

  // Weryfikacja tokenu: kim jest osoba i czy ma dozwoloną rolę na stronie firmy.
  const identity = await fetchMemberIdentity(config, token);
  const access = resolveAccess(config, identity);
  const store = new SqliteStore(config.paths.dbFile);
  try {
    const rec = buildTokenRecord({ accessToken: token, expiresInSec: Math.round(days * 86_400), scopes }, identity, access, 'import');
    const saved = await saveLogin(new SingleAccount(createTokenStore(config)), store, rec);
    await new AuditLog(store, config.paths.auditLogFile).record('cli', 'token_import', 'ok', saved.personUrn, { expiresAt: saved.expiresAt, scopes, roles: saved.roles });
    return {
      imported: true,
      profile_name: saved.profileName,
      person_urn: saved.personUrn,
      roles: saved.roles,
      organization_urn: saved.organizationUrn,
      expires_at_local: formatLocal(saved.expiresAt, config.defaultTimezone),
      scopes,
      note: 'Datę wygaśnięcia przyjęto z --expires-in-days (domyślnie 60 dni) - sprawdź ją w Developer Portal.',
    };
  } finally {
    await store.close();
  }
}

export async function tokenStatus(config: Config): Promise<Record<string, unknown>> {
  const info = await createTokenStore(config).info();
  return {
    ...info,
    expires_at_local: info.expiresAt ? formatLocal(info.expiresAt, config.defaultTimezone) : null,
    days_left: info.expiresAt ? Math.floor((new Date(info.expiresAt).getTime() - Date.now()) / 86_400_000) : null,
    mode: config.mode,
  };
}

export async function tokenClear(config: Config): Promise<Record<string, unknown>> {
  const removed = await createTokenStore(config).clear();
  const store = new SqliteStore(config.paths.dbFile);
  try {
    await store.setAuthMeta('live', null);
    await new AuditLog(store, config.paths.auditLogFile).record('cli', 'token_clear', 'ok', null, { removed });
  } finally {
    await store.close();
  }
  return { removed, message: removed ? 'Token LinkedIn usunięty z tego komputera.' : 'Nie było zapisanego tokenu.' };
}

/** Sprawdza token i role na stronie firmy prawdziwym wywołaniem API. */
export async function tokenVerify(config: Config): Promise<Record<string, unknown>> {
  const rec = await createTokenStore(config).load();
  if (!rec) return { valid: false, message: 'Brak tokenu. Zaloguj się: http://127.0.0.1:' + config.workerPort + '/oauth/start' };
  const identity = await fetchMemberIdentity(config, rec.accessToken);
  const access = resolveAccess(config, identity);
  return { valid: true, profile_name: identity.name, person_urn: identity.personUrn, roles: access.roles, organization_urn: access.organizationUrn, matches_saved: identity.personUrn === rec.personUrn };
}

/** Usuwa post z LinkedIn (sprzątanie po teście) i oznacza go w kolejce. */
export async function deleteLivePost(config: Config, postId: string | undefined, confirm: boolean): Promise<Record<string, unknown>> {
  if (!postId) throw new Error('Podaj identyfikator posta z kolejki, np. post_abc123.');
  const store = new SqliteStore(config.paths.dbFile);
  try {
    const post = await store.getPost(postId);
    if (!post) throw new Error(`Nie ma posta ${postId}.`);
    if (!post.linkedinPostUrn || post.mode !== 'live') throw new Error('Ten post nie został opublikowany na prawdziwym LinkedIn.');
    if (!confirm) {
      return { deleted: false, post_url: post.postUrl, message: `Aby usunąć post z LinkedIn, powtórz komendę z --yes: npm run cli -- linkedin delete-post ${postId} --yes` };
    }
    const client = new LiveLinkedIn({
      accounts: new SingleAccount(createTokenStore(config)),
      organizationUrn: organizationUrnFromConfig(config),
      apiBase: config.linkedin.apiBase,
      apiVersion: config.linkedin.apiVersion,
    });
    await client.deletePost(post.linkedinPostUrn);
    const now = new Date().toISOString();
    await store.addEvent(postId, 'deleted_on_linkedin', { postUrn: post.linkedinPostUrn }, now);
    await new AuditLog(store, config.paths.auditLogFile).record('cli', 'delete_live_post', 'ok', postId, { postUrn: post.linkedinPostUrn });
    return { deleted: true, post_urn: post.linkedinPostUrn, message: 'Post usunięty z LinkedIn (w kolejce zostaje z historią zdarzeń).' };
  } finally {
    await store.close();
  }
}
