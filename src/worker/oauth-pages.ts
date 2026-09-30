import type http from 'node:http';
import type { CoreContext, Logger } from '../core/index.js';
import { OAuthError, authorizationUrl, exchangeCode, fetchUserInfo, newState, requireClient, saveLogin } from '../core/linkedin/oauth.js';
import { formatLocal } from '../core/time.js';

/**
 * Strony logowania na 127.0.0.1:
 *   GET /oauth/start    -> przekierowanie do LinkedIn (z jednorazowym state, ważnym 10 minut)
 *   GET /oauth/callback -> sprawdzenie state, wymiana kodu na token, userinfo, zapis zaszyfrowanego tokenu
 * Działa w obu trybach (mock/live), żeby można było zalogować się przed przełączeniem na live.
 */
export class OAuthPages {
  private readonly states = new Map<string, number>();

  constructor(
    private readonly ctx: CoreContext,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async handle(url: URL, res: http.ServerResponse): Promise<boolean> {
    if (url.pathname === '/oauth/start') {
      this.start(res);
      return true;
    }
    if (url.pathname === '/oauth/callback') {
      await this.callback(url, res);
      return true;
    }
    return false;
  }

  private start(res: http.ServerResponse): void {
    try {
      requireClient(this.ctx.config);
    } catch (e) {
      return page(res, 500, 'Brak konfiguracji aplikacji LinkedIn', `<p>${esc((e as Error).message)}</p><p>Uzupełnij .env i uruchom ponownie worker: <code>npm run worker:restart</code>.</p>`);
    }
    const now = Date.now();
    for (const [s, exp] of this.states) if (exp < now) this.states.delete(s);
    const state = newState();
    this.states.set(state, now + 10 * 60_000);
    res.writeHead(302, { Location: authorizationUrl(this.ctx.config, state), 'Cache-Control': 'no-store' });
    res.end();
  }

  private async callback(url: URL, res: http.ServerResponse): Promise<void> {
    const q = url.searchParams;
    const state = q.get('state') ?? '';
    const exp = this.states.get(state);
    this.states.delete(state);
    if (!exp || exp < Date.now()) {
      await this.ctx.audit.record('oauth', 'oauth_callback', 'rejected', null, { reason: 'invalid_state' });
      return page(res, 401, 'Nieprawidłowa sesja logowania', '<p>Parametr <code>state</code> nie pasuje lub wygasł (ochrona przed CSRF). Zacznij od nowa: <a href="/oauth/start">/oauth/start</a>.</p>');
    }
    const error = q.get('error');
    if (error) {
      await this.ctx.audit.record('oauth', 'oauth_callback', 'rejected', null, { reason: error });
      const human = error === 'user_cancelled_authorize' || error === 'user_cancelled_login' ? 'Logowanie zostało anulowane.' : `LinkedIn zwrócił błąd: ${error}`;
      return page(res, 400, 'Logowanie nieudane', `<p>${esc(human)}</p><p>${esc(q.get('error_description') ?? '')}</p><p><a href="/oauth/start">Spróbuj ponownie</a></p>`);
    }
    const code = q.get('code');
    if (!code) return page(res, 400, 'Brak kodu', '<p>LinkedIn nie przekazał kodu autoryzacji.</p>');

    try {
      const tok = await exchangeCode(this.ctx.config, code, this.fetchImpl);
      const scopes = (tok.scope ?? this.ctx.config.linkedin.scopes.join(' ')).split(/[\s,]+/).filter(Boolean);
      const user = await fetchUserInfo(this.ctx.config, tok.access_token, this.fetchImpl);
      const saved = await saveLogin(
        this.ctx.tokens,
        this.ctx.store,
        { accessToken: tok.access_token, expiresInSec: tok.expires_in, refreshToken: tok.refresh_token, refreshExpiresInSec: tok.refresh_token_expires_in, scopes },
        user,
        'oauth',
      );
      await this.ctx.audit.record('oauth', 'oauth_login', 'ok', saved.personUrn, { expiresAt: saved.expiresAt, scopes: saved.scopes });
      this.log.info('Zalogowano do LinkedIn', { profile: saved.profileName, expiresAt: saved.expiresAt, scopes: saved.scopes });
      const missing = ['w_member_social'].filter((s) => !saved.scopes.includes(s));
      const modeNote =
        this.ctx.config.mode === 'mock'
          ? '<p><b>Worker działa w trybie atrapy</b> - nic jeszcze nie trafi na LinkedIn. Przełączenie: <code>LINKEDIN_MODE=live</code> w .env i <code>npm run worker:restart</code>.</p>'
          : '<p><b>Tryb live:</b> zatwierdzone posty będą publikowane na Twoim profilu.</p>';
      return page(
        res,
        200,
        'Połączono z LinkedIn',
        `<p>Konto: <b>${esc(saved.profileName ?? saved.personUrn)}</b></p>
         <p>Token ważny do: <b>${esc(formatLocal(saved.expiresAt, this.ctx.config.defaultTimezone))}</b></p>
         <p>Uprawnienia: <code>${esc(saved.scopes.join(' '))}</code></p>
         ${missing.length ? `<p style="color:#b00">Brak uprawnienia: ${esc(missing.join(', '))} - publikacja nie zadziała. Dodaj produkt „Share on LinkedIn” w Developer Portal.</p>` : ''}
         ${modeNote}
         <p>Możesz zamknąć tę kartę.</p>`,
      );
    } catch (e) {
      const msg = e instanceof OAuthError ? e.message : 'Nieoczekiwany błąd logowania (szczegóły w worker.log).';
      if (!(e instanceof OAuthError)) this.log.error('Błąd OAuth', { error: e instanceof Error ? e.message : String(e) });
      await this.ctx.audit.record('oauth', 'oauth_login', 'error', null, { error: msg });
      return page(res, 502, 'Logowanie nieudane', `<p>${esc(msg)}</p><p><a href="/oauth/start">Spróbuj ponownie</a></p>`);
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(res: http.ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'x-frame-options': 'DENY',
  });
  res.end(`<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.5}code{background:#eee;padding:1px 4px;border-radius:3px}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`);
}
