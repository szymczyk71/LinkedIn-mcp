import crypto from 'node:crypto';
import type http from 'node:http';
import type { OAuthToken } from '../core/db/server-data.js';
import { sha256Hex } from '../core/image.js';
import { OAuthError, exchangeCode, fetchUserInfo, saveLogin } from '../core/linkedin/oauth.js';
import type { Logger } from '../core/logger.js';
import { formatLocal } from '../core/time.js';
import { BodyTooLarge, esc, json, page, readBody } from '../web/html.js';
import type { ServerCore } from './core.js';

/**
 * Serwer autoryzacji OAuth 2.1 dla konektora Claude (claude.com/docs/connectors/building/authentication):
 * - zapytanie bez tokenu na /mcp -> 401 + WWW-Authenticate: Bearer resource_metadata="…"
 * - /.well-known/oauth-protected-resource  (resource = <base>/mcp, authorization_servers = [<base>])
 * - /.well-known/oauth-authorization-server (DCR, PKCE S256, klient publiczny: token_endpoint_auth_method "none")
 * - POST /register (DCR, JSON), GET /authorize (+ ekran z adresem zwrotnym), POST /token (form-urlencoded)
 * Tożsamość użytkownika potwierdza logowanie LinkedIn; to samo logowanie zapisuje token LinkedIn do publikacji.
 * Dostęp ma tylko właściciel: pierwsze konto LinkedIn, które się połączy (zapisane w ustawieniach "owner_person_urn").
 */

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const SCOPE = 'linkedin';
const AUTH_REQUEST_TTL_MIN = 10;
const CODE_TTL_MIN = 5;
const MAX_REFRESH_DAYS = 60;

const h = (s: string) => sha256Hex(Buffer.from(s));
const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');

export class OAuthServer {
  constructor(
    private readonly core: ServerCore,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get base(): string {
    return this.core.publicBaseUrl;
  }
  get resource(): string {
    return `${this.base}/mcp`;
  }
  get resourceMetadataUrl(): string {
    return `${this.base}/.well-known/oauth-protected-resource`;
  }
  private nowIso(): string {
    return this.core.clock.now().toISOString();
  }

  /** Obsługuje ścieżki OAuth; zwraca false, gdy ścieżka nie należy do serwera autoryzacji. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const m = req.method ?? 'GET';
    const p = url.pathname;
    if (m === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) {
      json(res, 200, {
        resource: this.resource,
        authorization_servers: [this.base],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ['header'],
        resource_name: 'LinkedIn – planer postów',
      });
      return true;
    }
    if (m === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration')) {
      json(res, 200, {
        issuer: this.base,
        authorization_endpoint: `${this.base}/authorize`,
        token_endpoint: `${this.base}/token`,
        registration_endpoint: `${this.base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [SCOPE],
      });
      return true;
    }
    if (m === 'POST' && p === '/register') return this.register(req, res).then(() => true);
    if (m === 'GET' && p === '/authorize') return this.authorize(res, url).then(() => true);
    if (m === 'GET' && p === '/authorize/continue') return this.continue(res, url).then(() => true);
    if (m === 'GET' && p === '/oauth/callback') return this.linkedinCallback(res, url).then(() => true);
    if (m === 'POST' && p === '/token') return this.token(req, res).then(() => true);
    return false;
  }

  /** Dozwolone adresy zwrotne: Claude (claude.ai, Desktop, telefon), loopback (Claude Code, MCP Inspector) i z konfiguracji. */
  isAllowedRedirect(uri: string): boolean {
    if (uri === CLAUDE_CALLBACK || this.core.config.http.extraRedirectUris.includes(uri)) return true;
    try {
      const u = new URL(uri);
      return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && !u.hash;
    } catch {
      return false;
    }
  }

  /** Porównanie z zarejestrowanym adresem; dla loopback bez portu (RFC 8252 7.3). */
  private redirectMatches(registered: string[], uri: string): boolean {
    if (registered.includes(uri)) return true;
    try {
      const u = new URL(uri);
      if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return false;
      return registered.some((r) => {
        const x = new URL(r);
        return x.protocol === u.protocol && x.hostname === u.hostname && x.pathname === u.pathname;
      });
    } catch {
      return false;
    }
  }

  // ---------- DCR ----------

  private async register(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
    try {
      body = JSON.parse((await readBody(req, 16_384)).toString('utf8'));
    } catch {
      return json(res, 400, { error: 'invalid_client_metadata', error_description: 'Niepoprawny JSON.' });
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length) return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'Brak redirect_uris.' });
    const bad = uris.filter((u) => !this.isAllowedRedirect(u));
    if (bad.length) return json(res, 400, { error: 'invalid_redirect_uri', error_description: `Niedozwolony adres zwrotny: ${bad.join(', ')}` });
    const clientId = `cl_${rnd(18)}`;
    const now = this.nowIso();
    const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : null;
    await this.core.db.createClient({ clientId, redirectUris: uris, clientName, createdAt: now });
    await this.core.audit.record('oauth', 'oauth_register_client', 'ok', clientId, { clientName, redirectUris: uris });
    json(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.parse(now) / 1000),
      client_name: clientName ?? undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }

  // ---------- /authorize ----------

  private async authorize(res: http.ServerResponse, url: URL): Promise<void> {
    const q = url.searchParams;
    const clientId = q.get('client_id') ?? '';
    const redirectUri = q.get('redirect_uri') ?? '';
    const client = clientId ? await this.core.db.getClient(clientId) : null;
    // Bez ważnego klienta i adresu zwrotnego nie przekierowujemy (ochrona przed otwartym przekierowaniem).
    if (!client) return page(res, 400, 'Nieznany klient', '<p>Aplikacja łącząca się z konektorem nie jest zarejestrowana. Dodaj konektor ponownie w Claude.</p>');
    if (!this.redirectMatches(client.redirectUris, redirectUri)) {
      return page(res, 400, 'Niepoprawny adres zwrotny', `<p>Adres <code>${esc(redirectUri)}</code> nie jest zarejestrowany dla tego klienta.</p>`);
    }
    const fail = (error: string, desc: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set('error', error);
      u.searchParams.set('error_description', desc);
      if (q.get('state')) u.searchParams.set('state', q.get('state')!);
      res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' });
      res.end();
    };
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Obsługiwane jest tylko response_type=code.');
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      return fail('invalid_request', 'Wymagane PKCE z code_challenge_method=S256.');
    }
    const resource = q.get('resource');
    if (resource && resource.replace(/\/$/, '') !== this.resource) return fail('invalid_target', `Nieznany zasób: ${resource}`);

    const id = rnd(24);
    await this.core.db.createAuthRequest({
      id,
      clientId,
      redirectUri,
      codeChallenge: challenge,
      clientState: q.get('state'),
      scope: q.get('scope') ?? SCOPE,
      expiresAt: new Date(this.core.clock.now().getTime() + AUTH_REQUEST_TTL_MIN * 60_000).toISOString(),
    });
    const host = new URL(redirectUri).host;
    const loopback = host.startsWith('localhost') || host.startsWith('127.0.0.1');
    // Ekran zgody pokazuje, dokąd trafi dostęp (wymóg specyfikacji MCP).
    page(
      res,
      200,
      'Połączenie z planerem LinkedIn',
      `<p><b>${esc(client.clientName ?? 'Aplikacja')}</b> prosi o dostęp do Twojego planera postów LinkedIn.</p>
       <p>Po zalogowaniu dostęp trafi do: <code>${esc(host)}</code></p>
       ${loopback ? '<p class="err">Uwaga: to adres lokalny (np. Claude Code lub MCP Inspector). Kontynuuj tylko, jeśli to Ty go uruchomiłeś.</p>' : ''}
       <p>Za chwilę zalogujesz się na LinkedIn. To samo logowanie daje planerowi prawo publikowania na Twoim profilu.</p>
       <p><a class="btn" href="/authorize/continue?req=${encodeURIComponent(id)}">Kontynuuj przez LinkedIn</a></p>
       <p class="muted">Dostęp ma wyłącznie właściciel planera.</p>`,
    );
  }

  private async continue(res: http.ServerResponse, url: URL): Promise<void> {
    const id = url.searchParams.get('req') ?? '';
    const p = new URLSearchParams({
      response_type: 'code',
      client_id: this.core.config.linkedin.clientId!,
      redirect_uri: this.core.config.linkedin.redirectUri,
      state: id,
      scope: this.core.config.linkedin.scopes.join(' '),
    });
    res.writeHead(302, { Location: `${this.core.config.linkedin.oauthBase}/oauth/v2/authorization?${p}`, 'Cache-Control': 'no-store' });
    res.end();
  }

  // ---------- powrót z LinkedIn ----------

  private async linkedinCallback(res: http.ServerResponse, url: URL): Promise<void> {
    const q = url.searchParams;
    const areq = await this.core.db.takeAuthRequest(q.get('state') ?? '', this.nowIso());
    if (!areq) {
      await this.core.audit.record('oauth', 'oauth_callback', 'rejected', null, { reason: 'invalid_state' });
      return page(res, 400, 'Sesja logowania wygasła', '<p>Zacznij od nowa: w Claude kliknij ponownie <b>Connect</b> przy konektorze.</p>');
    }
    const back = (params: Record<string, string>) => {
      const u = new URL(areq.redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (areq.clientState) u.searchParams.set('state', areq.clientState);
      res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' });
      res.end();
    };
    if (q.get('error')) {
      await this.core.audit.record('oauth', 'oauth_callback', 'rejected', null, { reason: q.get('error') });
      return back({ error: 'access_denied', error_description: 'Logowanie LinkedIn anulowane lub odrzucone.' });
    }
    try {
      const tok = await exchangeCode(this.core.config, q.get('code') ?? '', this.fetchImpl);
      const user = await fetchUserInfo(this.core.config, tok.access_token, this.fetchImpl);
      const personUrn = `urn:li:person:${user.sub}`;

      const owner = await this.core.db.getSetting('owner_person_urn');
      if (owner && owner !== personUrn) {
        await this.core.audit.record('oauth', 'oauth_login', 'rejected', personUrn, { reason: 'not_owner' });
        this.log.warn('Odmowa: logowanie kontem innym niż właściciel', { personUrn });
        return page(res, 403, 'Brak dostępu', '<p>To konto LinkedIn nie jest właścicielem tego planera. Dostęp ma tylko konto, które połączyło się jako pierwsze.</p>');
      }
      if (!owner) {
        await this.core.db.setSetting('owner_person_urn', personUrn, this.nowIso());
        await this.core.audit.record('oauth', 'owner_claimed', 'ok', personUrn, { profileName: user.name });
        this.log.info('Ustalono właściciela planera', { personUrn, profileName: user.name });
      }
      const scopes = (tok.scope ?? this.core.config.linkedin.scopes.join(' ')).split(/[\s,]+/).filter(Boolean);
      const saved = await saveLogin(
        this.core.tokens,
        this.core.store,
        { accessToken: tok.access_token, expiresInSec: tok.expires_in, refreshToken: tok.refresh_token, refreshExpiresInSec: tok.refresh_token_expires_in, scopes },
        user,
        'oauth',
        this.core.clock.now(),
      );
      await this.core.audit.record('oauth', 'oauth_login', 'ok', personUrn, { expiresAt: saved.expiresAt, scopes, client: areq.clientId });
      this.log.info('Zalogowano do LinkedIn przez konektor', { profile: saved.profileName, expiresAt: formatLocal(saved.expiresAt, this.core.config.defaultTimezone) });

      const code = rnd(32);
      await this.core.db.createCode({
        codeHash: h(code),
        clientId: areq.clientId,
        redirectUri: areq.redirectUri,
        codeChallenge: areq.codeChallenge,
        scope: areq.scope,
        personUrn,
        expiresAt: new Date(this.core.clock.now().getTime() + CODE_TTL_MIN * 60_000).toISOString(),
      });
      back({ code, iss: this.base });
    } catch (e) {
      const msg = e instanceof OAuthError ? e.message : 'Nieoczekiwany błąd logowania.';
      if (!(e instanceof OAuthError)) this.log.error('Błąd logowania LinkedIn', { error: e instanceof Error ? e.message : String(e) });
      await this.core.audit.record('oauth', 'oauth_login', 'error', null, { error: msg });
      back({ error: 'server_error', error_description: msg });
    }
  }

  // ---------- /token ----------

  private async token(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let form: URLSearchParams;
    try {
      form = new URLSearchParams((await readBody(req, 16_384)).toString('utf8'));
    } catch (e) {
      return json(res, e instanceof BodyTooLarge ? 413 : 400, { error: 'invalid_request' });
    }
    const err = (status: number, error: string, desc: string) => json(res, status, { error, error_description: desc }, { pragma: 'no-cache' });
    const clientId = form.get('client_id') ?? '';
    const client = clientId ? await this.core.db.getClient(clientId) : null;
    if (!client) return err(401, 'invalid_client', 'Nieznany klient.');
    const now = this.nowIso();

    if (form.get('grant_type') === 'authorization_code') {
      const code = await this.core.db.takeCode(h(form.get('code') ?? ''), now);
      if (!code || code.clientId !== clientId) return err(400, 'invalid_grant', 'Kod nieważny, wygasły albo już użyty.');
      if (form.get('redirect_uri') && form.get('redirect_uri') !== code.redirectUri) return err(400, 'invalid_grant', 'redirect_uri nie zgadza się z kodem.');
      const verifier = form.get('code_verifier') ?? '';
      const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || expected !== code.codeChallenge) return err(400, 'invalid_grant', 'Weryfikacja PKCE nie powiodła się.');
      return this.issue(res, clientId, code.personUrn, code.scope, rnd(12));
    }

    if (form.get('grant_type') === 'refresh_token') {
      const presented = h(form.get('refresh_token') ?? '');
      const t = await this.core.db.consumeRefreshToken(presented, now);
      if (!t) {
        const known = await this.core.db.getToken(presented);
        if (known?.kind === 'refresh' && known.revokedAt) {
          // Ponowne użycie unieważnionego tokenu odświeżania = możliwa kradzież: unieważniamy całą rodzinę.
          await this.core.db.revokeFamily(known.familyId, now);
          await this.core.audit.record('oauth', 'refresh_reuse_detected', 'rejected', known.clientId, { familyId: known.familyId });
        }
        return err(400, 'invalid_grant', 'Token odświeżania nieważny.');
      }
      if (t.clientId !== clientId) return err(400, 'invalid_grant', 'Token odświeżania należy do innego klienta.');
      const owner = await this.core.db.getSetting('owner_person_urn');
      if (owner !== t.personUrn) return err(400, 'invalid_grant', 'Zmienił się właściciel planera.');
      return this.issue(res, clientId, t.personUrn, t.scope, t.familyId);
    }
    return err(400, 'unsupported_grant_type', 'Obsługiwane: authorization_code, refresh_token.');
  }

  /**
   * Wydaje parę tokenów. Token odświeżania żyje najwyżej do wygaśnięcia logowania LinkedIn - potem Claude
   * dostaje invalid_grant i prosi o ponowne połączenie, co przy okazji odnawia token LinkedIn.
   */
  private async issue(res: http.ServerResponse, clientId: string, personUrn: string, scope: string | null, familyId: string): Promise<void> {
    const now = this.core.clock.now();
    const ttl = this.core.config.http.accessTokenTtlMin;
    const access = rnd(32);
    const refresh = rnd(32);
    const li = await this.core.tokens.info();
    const liExpiry = li.expiresAt ? Date.parse(li.expiresAt) : now.getTime();
    const refreshExpiry = Math.min(liExpiry, now.getTime() + MAX_REFRESH_DAYS * 86_400_000);
    const base = { clientId, familyId, scope, personUrn, revokedAt: null, createdAt: now.toISOString() };
    await this.core.db.createToken({ ...base, tokenHash: h(access), kind: 'access', expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString() });
    const withRefresh = refreshExpiry > now.getTime() + 60_000;
    if (withRefresh) await this.core.db.createToken({ ...base, tokenHash: h(refresh), kind: 'refresh', expiresAt: new Date(refreshExpiry).toISOString() });
    await this.core.audit.record('oauth', 'oauth_token_issued', 'ok', clientId, { accessTtlMin: ttl, refreshUntil: withRefresh ? new Date(refreshExpiry).toISOString() : null });
    json(
      res,
      200,
      { access_token: access, token_type: 'Bearer', expires_in: ttl * 60, scope: scope ?? SCOPE, ...(withRefresh ? { refresh_token: refresh } : {}) },
      { pragma: 'no-cache' },
    );
  }

  /** Weryfikacja tokenu dostępu z nagłówka Authorization. */
  async verifyBearer(header: string | undefined): Promise<OAuthToken | null> {
    if (!header?.startsWith('Bearer ')) return null;
    const t = await this.core.db.getToken(h(header.slice(7).trim()));
    if (!t || t.kind !== 'access' || t.revokedAt || t.expiresAt <= this.nowIso()) return null;
    const owner = await this.core.db.getSetting('owner_person_urn');
    return owner === t.personUrn ? t : null;
  }

  unauthorized(res: http.ServerResponse, description = 'Wymagane logowanie.'): void {
    json(
      res,
      401,
      { error: 'invalid_token', error_description: description },
      { 'www-authenticate': `Bearer resource_metadata="${this.resourceMetadataUrl}", error="invalid_token", scope="${SCOPE}"` },
    );
  }
}
