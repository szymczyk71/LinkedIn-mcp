import fs from 'node:fs';
import { escapeLittle } from '../little.js';
import type { TokenRecord, TokenStore } from '../token-store.js';
import {
  LinkedInError,
  type AuthInfo,
  type CommentInput,
  type CommentResult,
  type LinkedInClient,
  type PublishImage,
  type PublishInput,
  type PublishResult,
} from './client.js';

/**
 * Klient prawdziwego API LinkedIn. Źródła (learn.microsoft.com, wersja 2026-09):
 * - Posts API:     POST {api}/rest/posts, nagłówki Linkedin-Version (RRRRMM) i X-Restli-Protocol-Version: 2.0.0,
 *                  lifecycleState PUBLISHED (jedyna wartość przy tworzeniu), ID posta w nagłówku x-restli-id
 * - little format: commentary z escapowanymi znakami zastrzeżonymi (little.ts)
 * - Images API:    POST {api}/rest/images?action=initializeUpload (owner = urn:li:person), PUT pliku na uploadUrl
 *                  z nagłówkiem Authorization, post z content.media { id, altText }
 * - Comments API:  POST {api}/rest/socialActions/{postUrn}/comments  { actor, object, message: { text } }
 * - userinfo:      GET {api}/v2/userinfo (OpenID) -> sub; autor = urn:li:person:{sub}
 */

export interface LiveOptions {
  tokens: TokenStore;
  apiBase: string;
  apiVersion: string;
  visibility: 'PUBLIC' | 'CONNECTIONS';
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Ile czekać na przetworzenie obrazu przed utworzeniem posta. */
  imageReadyTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Stage = 'before_send' | 'create';

export class LiveLinkedIn implements LinkedInClient {
  readonly mode = 'live' as const;
  private readonly f: typeof fetch;

  constructor(private readonly o: LiveOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  /** Dane z tokenu zapisane przy logowaniu - bez wywołania API (limit 150 wywołań dziennie). */
  async checkAuth(): Promise<AuthInfo> {
    const rec = await this.o.tokens.load().catch(() => null);
    const disconnected: AuthInfo = { connected: false, personUrn: null, profileName: null, profileUrl: null, expiresAt: rec?.expiresAt ?? null, scopes: rec?.scopes ?? [], canPost: false };
    if (!rec || new Date(rec.expiresAt).getTime() <= Date.now()) return disconnected;
    return {
      connected: true,
      personUrn: rec.personUrn,
      profileName: rec.profileName,
      profileUrl: null,
      expiresAt: rec.expiresAt,
      scopes: rec.scopes,
      canPost: rec.scopes.length === 0 || rec.scopes.includes('w_member_social'),
    };
  }

  async publishPost(input: PublishInput): Promise<PublishResult> {
    const rec = await this.token();
    let media: { id: string; altText?: string } | undefined;
    if (input.image) media = await this.uploadImage(rec, input.image);

    const body: Record<string, unknown> = {
      author: rec.personUrn,
      commentary: escapeLittle(input.text),
      visibility: this.o.visibility,
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(media ? { content: { media } } : {}),
    };
    const res = await this.call(rec, 'POST', '/rest/posts', body, 'create');
    const urn = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id');
    if (res.status !== 201 || !urn) {
      throw new LinkedInError('ambiguous', `LinkedIn odpowiedział ${res.status} bez identyfikatora posta - post mógł powstać.`, res.status);
    }
    return { postUrn: urn, postUrl: `https://www.linkedin.com/feed/update/${urn}/` };
  }

  async addComment(input: CommentInput): Promise<CommentResult> {
    const rec = await this.token();
    const res = await this.call(
      rec,
      'POST',
      `/rest/socialActions/${encodeURIComponent(input.postUrn)}/comments`,
      { actor: rec.personUrn, object: input.postUrn, message: { text: input.text } },
      'create',
    );
    const body = (await res.json().catch(() => null)) as { commentUrn?: string; id?: string } | null;
    const id = res.headers.get('x-restli-id') ?? body?.id;
    const commentUrn = body?.commentUrn ?? (id ? `urn:li:comment:(${input.postUrn},${id})` : null);
    if (!commentUrn) throw new LinkedInError('ambiguous', `LinkedIn odpowiedział ${res.status} bez identyfikatora komentarza - komentarz mógł powstać.`, res.status);
    return { commentUrn };
  }

  /** Usunięcie posta (sprzątanie po teście). Idempotentne według dokumentacji (204 także dla usuniętego). */
  async deletePost(postUrn: string): Promise<void> {
    const rec = await this.token();
    await this.call(rec, 'DELETE', `/rest/posts/${encodeURIComponent(postUrn)}`, undefined, 'before_send', { 'X-RestLi-Method': 'DELETE' });
  }

  // ---------- obrazy ----------

  private async uploadImage(rec: TokenRecord, img: PublishImage): Promise<{ id: string; altText?: string }> {
    // Wszystko przed utworzeniem posta: błędy są jednoznaczne (post na pewno nie powstał).
    try {
      const init = await this.call(rec, 'POST', '/rest/images?action=initializeUpload', { initializeUploadRequest: { owner: rec.personUrn } }, 'before_send');
      const j = (await init.json()) as { value?: { uploadUrl?: string; image?: string } };
      const uploadUrl = j.value?.uploadUrl;
      const imageUrn = j.value?.image;
      if (!uploadUrl || !imageUrn) throw new LinkedInError('rejected', 'LinkedIn nie zwrócił adresu wysyłania obrazu.');

      const data = fs.readFileSync(img.file);
      let up: Response;
      try {
        up = await this.f(uploadUrl, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${rec.accessToken}`, 'Content-Type': img.mime },
          body: data,
          signal: AbortSignal.timeout(this.o.uploadTimeoutMs ?? 120_000),
        });
      } catch (e) {
        throw new LinkedInError('network', `Błąd połączenia przy wysyłaniu obrazu: ${errMessage(e)}`);
      }
      if (!up.ok) throw classify(up.status, await safeText(up), 'before_send', 'wysyłanie obrazu');

      await this.waitForImage(rec, imageUrn);
      return { id: imageUrn, ...(img.alt ? { altText: img.alt } : {}) };
    } catch (e) {
      if (e instanceof LinkedInError && e.ambiguous) throw new LinkedInError('network', e.message, e.httpStatus);
      throw e;
    }
  }

  /**
   * Images API przetwarza obraz asynchronicznie; post utworzony przed zakończeniem może nie być widoczny.
   * Sprawdzamy status (GET /rest/images/{urn}); jeśli token z samym w_member_social nie ma prawa do GET (403),
   * czekamy krótko i idziemy dalej.
   */
  private async waitForImage(rec: TokenRecord, imageUrn: string): Promise<void> {
    const end = Date.now() + (this.o.imageReadyTimeoutMs ?? 30_000);
    while (Date.now() < end) {
      let res: Response;
      try {
        res = await this.f(`${this.o.apiBase}/rest/images/${encodeURIComponent(imageUrn)}`, {
          headers: this.headers(rec),
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
        });
      } catch {
        await sleep(2000);
        continue;
      }
      if (res.status === 403 || res.status === 401) {
        await sleep(3000);
        return;
      }
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { status?: string };
        if (j.status === 'AVAILABLE') return;
        if (j.status === 'PROCESSING_FAILED') throw new LinkedInError('rejected', 'LinkedIn nie przetworzył obrazu (PROCESSING_FAILED).');
      }
      await sleep(2000);
    }
    throw new LinkedInError('rejected', 'Obraz nie został przetworzony przez LinkedIn w wyznaczonym czasie - post nie został wysłany.');
  }

  // ---------- HTTP ----------

  private headers(rec: TokenRecord, extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${rec.accessToken}`,
      'Linkedin-Version': this.o.apiVersion,
      'X-Restli-Protocol-Version': '2.0.0',
      ...extra,
    };
  }

  private async call(
    rec: TokenRecord,
    method: string,
    path: string,
    body: unknown,
    stage: Stage,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.f(`${this.o.apiBase}${path}`, {
        method,
        headers: this.headers(rec, body === undefined ? extra : { 'Content-Type': 'application/json', ...extra }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw fetchFailure(e, stage);
    }
    if (res.ok) return res;
    throw classify(res.status, await safeText(res), stage, path);
  }

  private async token(): Promise<TokenRecord> {
    const rec = await this.o.tokens.load();
    if (!rec) throw new LinkedInError('unauthorized', 'Brak logowania do LinkedIn. Zaloguj się: http://127.0.0.1:47811/oauth/start');
    if (new Date(rec.expiresAt).getTime() <= Date.now()) throw new LinkedInError('unauthorized', `Token LinkedIn wygasł ${rec.expiresAt}. Zaloguj się ponownie.`);
    return rec;
  }
}

/** Błąd transportu: przed wysłaniem = jednoznaczny; timeout / zerwanie przy tworzeniu = niejednoznaczny. */
function fetchFailure(e: unknown, stage: Stage): LinkedInError {
  const name = (e as Error)?.name;
  const code = (e as { cause?: { code?: string } })?.cause?.code ?? '';
  const beforeConnect = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
  if (beforeConnect || stage === 'before_send') return new LinkedInError('network', `Brak połączenia z LinkedIn (${code || name || 'błąd sieci'}).`);
  if (name === 'TimeoutError' || name === 'AbortError') return new LinkedInError('timeout', 'Brak odpowiedzi LinkedIn po wysłaniu żądania (timeout).');
  return new LinkedInError('ambiguous', `Połączenie z LinkedIn zerwane po wysłaniu żądania (${code || name}).`);
}

function classify(status: number, text: string, stage: Stage, what: string): LinkedInError {
  const detail = extractMessage(text);
  const msg = `LinkedIn ${status} (${what})${detail ? `: ${detail}` : ''}`;
  if (status === 401) return new LinkedInError('unauthorized', `${msg}. Zaloguj się ponownie.`, status);
  if (status === 403) return new LinkedInError('forbidden', msg, status);
  if (status === 429) return new LinkedInError('rate_limited', msg, status);
  if (status >= 500) return new LinkedInError(stage === 'create' ? 'ambiguous' : 'network', msg, status);
  return new LinkedInError('rejected', msg, status);
}

function extractMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: string; serviceErrorCode?: number; code?: string };
    return [j.code, j.message].filter(Boolean).join(' - ').slice(0, 300);
  } catch {
    return text.slice(0, 200);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
