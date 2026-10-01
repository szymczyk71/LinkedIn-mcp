import crypto from 'node:crypto';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { Accounts } from '../accounts.js';
import { EnvOrKeyringKeyProvider, TokenStore, type TokenRecord } from '../token-store.js';

/**
 * OAuth 2.0 (3-legged, authorization code) wg learn.microsoft.com/linkedin/shared/authentication/authorization-code-flow:
 *   GET  {oauth}/oauth/v2/authorization?response_type=code&client_id&redirect_uri&state&scope
 *   POST {oauth}/oauth/v2/accessToken (x-www-form-urlencoded: grant_type, code, client_id, client_secret, redirect_uri)
 *   -> access_token, expires_in (obecnie 60 dni), opcjonalnie refresh_token, scope
 * Tożsamość i uprawnienia: GET {api}/rest/organizationAcls?q=roleAssignee (role na stronach firm) + opcjonalnie /v2/me.
 */

export function createTokenStore(config: Config): TokenStore {
  return new TokenStore(config.paths.tokenStoreFile, new EnvOrKeyringKeyProvider(config.encKeyFromEnv));
}

export class OAuthError extends Error {
  override name = 'OAuthError';
}

export function requireClient(config: Config): { clientId: string; clientSecret: string } {
  const { clientId, clientSecret } = config.linkedin;
  if (!clientId || !clientSecret) {
    throw new OAuthError('Brak LINKEDIN_CLIENT_ID lub LINKEDIN_CLIENT_SECRET w pliku .env (katalog repozytorium).');
  }
  return { clientId, clientSecret };
}

export function authorizationUrl(config: Config, state: string): string {
  const { clientId } = requireClient(config);
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: config.linkedin.redirectUri,
    state,
    scope: config.linkedin.scopes.join(' '),
  });
  return `${config.linkedin.oauthBase}/oauth/v2/authorization?${p.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

export async function exchangeCode(config: Config, code: string, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  const { clientId, clientSecret } = requireClient(config);
  const res = await fetchImpl(`${config.linkedin.oauthBase}/oauth/v2/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: config.linkedin.redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let desc = '';
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      desc = [j.error, j.error_description].filter(Boolean).join(': ');
    } catch {
      /* bez szczegółów */
    }
    throw new OAuthError(`LinkedIn odrzucił wymianę kodu (${res.status})${desc ? ': ' + desc : ''}.`);
  }
  const j = JSON.parse(text) as TokenResponse;
  if (!j.access_token || !j.expires_in) throw new OAuthError('Odpowiedź LinkedIn nie zawiera access_token/expires_in.');
  return j;
}

/** Osoba zalogowana w LinkedIn i jej role na stronach firm (stan APPROVED). */
export interface MemberIdentity {
  personUrn: string;
  name: string | null;
  acls: { organizationUrn: string; role: string }[];
}

export class AccessDenied extends OAuthError {
  override name = 'AccessDenied';
}

function apiHeaders(config: Config, accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Linkedin-Version': config.linkedin.apiVersion, 'X-Restli-Protocol-Version': '2.0.0' };
}

/**
 * Kim jest zalogowana osoba i jakie ma role na stronach firm:
 *   GET {api}/rest/organizationAcls?q=roleAssignee&state=APPROVED  (r_organization_admin / rw_organization_admin)
 * Odpowiedź zawiera roleAssignee (urn:li:person:...) - identyfikator osoby bez produktu "Sign In with LinkedIn".
 * Imię i nazwisko: GET {api}/v2/me (r_basicprofile) - opcjonalnie, brak uprawnienia nie blokuje logowania.
 */
export async function fetchMemberIdentity(config: Config, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<MemberIdentity> {
  const res = await fetchImpl(`${config.linkedin.apiBase}/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100`, {
    headers: apiHeaders(config, accessToken),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new OAuthError(`LinkedIn odrzucił odczyt ról administratorów (${res.status}). Aplikacja musi mieć uprawnienie r_organization_admin (Community Management API).`);
  }
  if (!res.ok) throw new OAuthError(`Nie udało się odczytać ról na stronach firm (organizationAcls ${res.status}).`);
  const j = (await res.json()) as { elements?: { role?: string; organization?: string; organizationTarget?: string; roleAssignee?: string; state?: string }[] };
  const elements = (j.elements ?? []).filter((e) => (e.state ?? 'APPROVED') === 'APPROVED');
  const acls = elements
    .map((e) => ({ organizationUrn: e.organization ?? e.organizationTarget ?? '', role: e.role ?? '' }))
    .filter((a) => a.organizationUrn && a.role);

  let personUrn = elements.find((e) => e.roleAssignee)?.roleAssignee ?? null;
  let name: string | null = null;
  try {
    const me = await fetchImpl(`${config.linkedin.apiBase}/v2/me`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
    if (me.ok) {
      const m = (await me.json()) as { id?: string; localizedFirstName?: string; localizedLastName?: string };
      name = [m.localizedFirstName, m.localizedLastName].filter(Boolean).join(' ') || null;
      if (!personUrn && m.id) personUrn = `urn:li:person:${m.id}`;
    }
  } catch {
    /* imię i nazwisko są opcjonalne */
  }
  if (!personUrn) throw new AccessDenied('To konto LinkedIn nie jest administratorem żadnej strony firmy.');
  return { personUrn, name, acls };
}

export function organizationUrnFromConfig(config: Config): string | null {
  return config.linkedin.organizationId ? `urn:li:organization:${config.linkedin.organizationId}` : null;
}

/** Sprawdza, czy osoba ma dozwoloną rolę na stronie firmy z konfiguracji. Zwraca role tej osoby na tej stronie. */
export function resolveAccess(config: Config, identity: MemberIdentity): { organizationUrn: string; roles: string[] } {
  const org = organizationUrnFromConfig(config);
  if (!org) {
    const ids = [...new Set(identity.acls.map((a) => a.organizationUrn.split(':').pop()))].join(', ') || 'brak';
    throw new OAuthError(`Brak LINKEDIN_ORGANIZATION_ID w konfiguracji. Strony, na których to konto ma role: ${ids}.`);
  }
  const roles = [...new Set(identity.acls.filter((a) => a.organizationUrn === org).map((a) => a.role))];
  const allowed = roles.filter((r) => config.linkedin.allowedRoles.includes(r));
  if (!allowed.length) {
    throw new AccessDenied(
      roles.length
        ? `To konto ma na stronie firmy role ${roles.join(', ')}, a planer wymaga jednej z: ${config.linkedin.allowedRoles.join(', ')}.`
        : 'To konto nie jest administratorem strony firmy, w imieniu której działa planer.',
    );
  }
  return { organizationUrn: org, roles };
}

export function buildTokenRecord(
  token: { accessToken: string; expiresInSec: number; refreshToken?: string | null; refreshExpiresInSec?: number | null; scopes: string[] },
  identity: MemberIdentity,
  access: { organizationUrn: string; roles: string[] },
  source: TokenRecord['source'],
  now = new Date(),
): TokenRecord {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? null,
    expiresAt: new Date(now.getTime() + token.expiresInSec * 1000).toISOString(),
    refreshTokenExpiresAt: token.refreshExpiresInSec ? new Date(now.getTime() + token.refreshExpiresInSec * 1000).toISOString() : null,
    scopes: token.scopes,
    personUrn: identity.personUrn,
    profileName: identity.name,
    organizationUrn: access.organizationUrn,
    roles: access.roles,
    obtainedAt: now.toISOString(),
    source,
  };
}

/** Zapisuje logowanie osoby (zaszyfrowany token) i metadane strony. Zwraca rekord bez tokenów. */
export async function saveLogin(
  accounts: Accounts,
  store: Store,
  rec: TokenRecord,
  now = new Date(),
): Promise<Omit<TokenRecord, 'accessToken' | 'refreshToken'>> {
  await accounts.saveLogin(rec, now.toISOString());
  const prev = await store.getAuthMeta('live');
  await store.setAuthMeta('live', {
    personUrn: rec.organizationUrn, // metadane "live" dotyczą strony firmy (can_comment jako strona)
    profileName: prev?.profileName ?? null,
    profileUrl: null,
    expiresAt: prev?.expiresAt ?? null,
    scopes: rec.scopes,
    canComment: prev?.personUrn === rec.organizationUrn ? prev.canComment : 'unknown',
    updatedAt: now.toISOString(),
  });
  const { accessToken: _a, refreshToken: _r, ...safe } = rec;
  return safe;
}

export function newState(): string {
  return crypto.randomBytes(24).toString('base64url');
}
