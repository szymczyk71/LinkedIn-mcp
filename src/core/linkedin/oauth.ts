import crypto from 'node:crypto';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import { EnvOrKeyringKeyProvider, TokenStore, type TokenRecord } from '../token-store.js';

/**
 * OAuth 2.0 (3-legged, authorization code) wg learn.microsoft.com/linkedin/shared/authentication/authorization-code-flow:
 *   GET  {oauth}/oauth/v2/authorization?response_type=code&client_id&redirect_uri&state&scope
 *   POST {oauth}/oauth/v2/accessToken (x-www-form-urlencoded: grant_type, code, client_id, client_secret, redirect_uri)
 *   -> access_token, expires_in (obecnie 60 dni), opcjonalnie refresh_token, scope
 * Profil: GET {api}/v2/userinfo (OpenID) -> sub, name.
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

export interface UserInfo {
  sub: string;
  name: string | null;
}

export async function fetchUserInfo(config: Config, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<UserInfo> {
  const res = await fetchImpl(`${config.linkedin.apiBase}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new OAuthError(`LinkedIn odrzucił token przy odczycie profilu (${res.status}). Token musi mieć zakresy openid i profile.`);
  }
  if (!res.ok) throw new OAuthError(`Nie udało się odczytać profilu (userinfo ${res.status}).`);
  const j = (await res.json()) as { sub?: string; name?: string; given_name?: string; family_name?: string };
  if (!j.sub) throw new OAuthError('userinfo nie zwróciło identyfikatora (sub).');
  const name = j.name ?? ([j.given_name, j.family_name].filter(Boolean).join(' ') || null);
  return { sub: j.sub, name };
}

/** Zapisuje token (zaszyfrowany) i metadane profilu. Zwraca rekord bez ujawniania tokenu na zewnątrz. */
export async function saveLogin(
  tokens: TokenStore,
  store: Store,
  token: { accessToken: string; expiresInSec: number; refreshToken?: string | null; refreshExpiresInSec?: number | null; scopes: string[] },
  user: UserInfo,
  source: TokenRecord['source'],
  now = new Date(),
): Promise<Omit<TokenRecord, 'accessToken' | 'refreshToken'>> {
  const rec: TokenRecord = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? null,
    expiresAt: new Date(now.getTime() + token.expiresInSec * 1000).toISOString(),
    refreshTokenExpiresAt: token.refreshExpiresInSec ? new Date(now.getTime() + token.refreshExpiresInSec * 1000).toISOString() : null,
    scopes: token.scopes,
    personUrn: `urn:li:person:${user.sub}`,
    profileName: user.name,
    obtainedAt: now.toISOString(),
    source,
  };
  await tokens.save(rec);
  const prev = await store.getAuthMeta('live');
  const samePerson = prev?.personUrn === rec.personUrn;
  await store.setAuthMeta('live', {
    personUrn: rec.personUrn,
    profileName: rec.profileName,
    profileUrl: null,
    expiresAt: rec.expiresAt,
    scopes: rec.scopes,
    // can_comment dotyczy prawdziwego konta: po zmianie konta albo pierwszym logowaniu - "unknown".
    canComment: samePerson ? prev!.canComment : 'unknown',
    updatedAt: now.toISOString(),
  });
  const { accessToken: _a, refreshToken: _r, ...safe } = rec;
  return safe;
}

export function newState(): string {
  return crypto.randomBytes(24).toString('base64url');
}
