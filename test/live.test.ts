import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeClock,
  LinkedInError,
  LinkedInService,
  LiveLinkedIn,
  Scheduler,
  SingleAccount,
  SqliteStore,
  StaticKeyProvider,
  TokenStore,
  buildTokenRecord,
  createCore,
  createLogger,
  createTokenStore,
  escapeLittle,
  extractHashtags,
  loadConfig,
  pickFrom,
  saveLogin,
  type AccountInfo,
  type Accounts,
  type Config,
  type CoreContext,
  type PickOptions,
  type TokenRecord,
} from '../src/core/index.js';
import { newPostFromPlanned } from '../src/core/posts.js';
import { startApi } from '../src/worker/api.js';
import { FakeLinkedInServer, ORG } from './fake-linkedin-server.js';
import { plannedPost, tmpDataDir } from './helpers.js';

const ENC_KEY = crypto.randomBytes(32).toString('base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let fake: FakeLinkedInServer;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

async function closedPort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as import('node:net').AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

beforeEach(async () => {
  fake = new FakeLinkedInServer();
  await fake.start();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  await fake.stop();
});

function liveConfig(extra: Record<string, string> = {}): Config {
  return loadConfig(
    {
      LINKEDIN_MCP_DATA_DIR: tmpDataDir(),
      LINKEDIN_MODE: 'live',
      LINKEDIN_CLIENT_ID: 'client-id-123',
      LINKEDIN_CLIENT_SECRET: 'client-secret-xyz',
      LINKEDIN_MCP_ENC_KEY: ENC_KEY,
      LINKEDIN_API_BASE: fake.base,
      LINKEDIN_OAUTH_BASE: fake.base,
      LINKEDIN_ORGANIZATION_ID: '1001',
      ...extra,
    },
    { envFile: false },
  );
}

function recordFor(sub: string, roles: string[], expiresInSec = 60 * 86_400): TokenRecord {
  const u = fake.user(sub);
  return buildTokenRecord(
    { accessToken: u.token, expiresInSec, scopes: ['r_organization_admin', 'w_organization_social'] },
    { personUrn: `urn:li:person:${sub}`, name: u.name, acls: roles.map((role) => ({ organizationUrn: ORG, role })) },
    { organizationUrn: ORG, roles },
    'oauth',
  );
}

async function loggedIn(config: Config, store: SqliteStore) {
  await saveLogin(new SingleAccount(createTokenStore(config)), store, recordFor(fake.sub, ['ADMINISTRATOR']));
}

function client(accounts: Accounts, opts: Partial<ConstructorParameters<typeof LiveLinkedIn>[0]> = {}) {
  return new LiveLinkedIn({ accounts, organizationUrn: ORG, apiBase: fake.base, apiVersion: '202609', imageReadyTimeoutMs: 3000, ...opts });
}

/** Konta w pamięci (zamiast bazy) - do testów wyboru tokenu przy kilku administratorach. */
class MemAccounts implements Accounts {
  readonly recs = new Map<string, TokenRecord>();
  readonly status = new Map<string, AccountInfo['status']>();
  async saveLogin(rec: TokenRecord) {
    this.recs.set(rec.personUrn, rec);
    this.status.set(rec.personUrn, 'active');
  }
  async get(u: string) {
    return this.recs.get(u) ?? null;
  }
  async info(u: string) {
    return (await this.list()).find((a) => a.personUrn === u) ?? null;
  }
  async list(): Promise<AccountInfo[]> {
    return [...this.recs.values()].map((r) => ({
      personUrn: r.personUrn,
      name: r.profileName,
      roles: r.roles,
      status: this.status.get(r.personUrn) ?? 'active',
      tokenPresent: true,
      expiresAt: r.expiresAt,
      lastLoginAt: r.obtainedAt,
      lastVerifiedAt: r.obtainedAt,
    }));
  }
  async pick(o: PickOptions, now: string) {
    return pickFrom(await this.list(), (u) => this.get(u), o, now);
  }
  async setVerified(u: string, s: AccountInfo['status']) {
    this.status.set(u, s);
  }
  async remove(u: string) {
    return this.recs.delete(u);
  }
}

async function setupLive(extra: Record<string, string> = {}) {
  const config = liveConfig(extra);
  const store = new SqliteStore(':memory:');
  cleanups.push(() => store.close());
  await loggedIn(config, store);
  const clock = new FakeClock('2026-11-06T07:00:00.000Z');
  const accounts = new SingleAccount(createTokenStore(config));
  const li = client(accounts);
  const ctx: CoreContext = createCore(config, { store, linkedin: li, clock, auditFile: null, accounts });
  return { config, store, clock, li, ctx, accounts, svc: new LinkedInService(ctx), scheduler: new Scheduler(ctx) };
}

async function expectKind(p: Promise<unknown>, kind: string, ambiguous: boolean) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(LinkedInError);
  expect((e as LinkedInError).kind).toBe(kind);
  expect((e as LinkedInError).ambiguous).toBe(ambiguous);
}

describe('format little (commentary)', () => {
  it('escapuje znaki zastrzeżone, zostawia hashtagi', () => {
    expect(escapeLittle('Nawiasy (a) [b] {c} <d> | @kto *gw* _pod_ ~t~ \\ C# koniec')).toBe(
      'Nawiasy \\(a\\) \\[b\\] \\{c\\} \\<d\\> \\| \\@kto \\*gw\\* \\_pod\\_ \\~t\\~ \\\\ C\\# koniec',
    );
    expect(escapeLittle('#NIS2 i #Łódź, (#AI) oraz # samotny')).toBe('#NIS2 i #Łódź, \\(#AI\\) oraz \\# samotny');
    expect(escapeLittle('„cudzysłów” – półpauza, emoji 🙂 i nowa\nlinia')).toBe('„cudzysłów” – półpauza, emoji 🙂 i nowa\nlinia');
    expect(extractHashtags('#NIS2 test C# i #Łódź')).toEqual(['NIS2', 'Łódź']);
  });
});

describe('szyfrowanie tokenów', () => {
  it('AES-256-GCM: odczyt tym samym kluczem, brak tokenu jawnym tekstem, zły klucz = błąd', async () => {
    const file = path.join(tmpDataDir(), 'tokens.enc');
    const key = crypto.randomBytes(32);
    const ts = new TokenStore(file, new StaticKeyProvider(key));
    const rec = { ...recordFor(fake.sub, ['ADMINISTRATOR']), accessToken: 'SEKRETNY_TOKEN_123' };
    await ts.save(rec);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('SEKRETNY_TOKEN_123');
    expect(await ts.load()).toEqual(rec);
    expect(JSON.stringify(await ts.info())).not.toContain('SEKRETNY');
    await expect(new TokenStore(file, new StaticKeyProvider(crypto.randomBytes(32))).load()).rejects.toThrow(/odszyfrować/);
    expect(await ts.clear()).toBe(true);
    expect(await ts.load()).toBeNull();
  });
});

describe('LiveLinkedIn: publikacja jako strona firmy (atrapa serwera HTTP)', () => {
  it('post: autor = strona firmy, nagłówki wersji, commentary w formacie little, PUBLIC', async () => {
    const { accounts } = await setupLive();
    const r = await client(accounts).publishPost({ text: 'Test (1) #NIS2 @ktoś', idempotencyKey: 'k' });
    expect(r.postUrn).toMatch(/^urn:li:share:\d+$/);
    expect(r.publishedBy).toBe(`urn:li:person:${fake.sub}`);
    const req = fake.requests.find((x) => x.path === '/rest/posts')!;
    expect(req.headers['linkedin-version']).toBe('202609');
    expect(req.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(req.json).toEqual({
      author: ORG,
      commentary: 'Test \\(1\\) #NIS2 \\@ktoś',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('obraz: initializeUpload z właścicielem = strona, PUT z tokenem, post z content.media i altText', async () => {
    const { accounts } = await setupLive();
    await client(accounts).publishPost({ text: 'Z obrazem', idempotencyKey: 'k', image: { data: PNG, mime: 'image/png', sha256: 'x', bytes: PNG.length, alt: 'Opis' } });
    expect(fake.requests.find((x) => x.path.startsWith('/rest/images?action=initializeUpload'))!.json).toEqual({ initializeUploadRequest: { owner: ORG } });
    const put = fake.requests.find((x) => x.method === 'PUT')!;
    expect(put.headers.authorization).toBe(`Bearer ${fake.accessToken}`);
    expect(put.body.equals(PNG)).toBe(true);
    expect(fake.requests.find((x) => x.path === '/rest/posts')!.json.content).toEqual({ media: { id: expect.stringMatching(/^urn:li:image:/), altText: 'Opis' } });
  });

  it('obraz: 403 przy sprawdzaniu statusu -> krótkie czekanie i publikacja', async () => {
    const { accounts } = await setupLive();
    fake.behavior.imageStatus = 403;
    await expect(client(accounts).publishPost({ text: 'x', idempotencyKey: 'k', image: { data: PNG, mime: 'image/png', sha256: 'x', bytes: 1, alt: '' } })).resolves.toBeTruthy();
  });

  it('komentarz: actor = strona firmy, URN posta zakodowany w ścieżce', async () => {
    const { accounts } = await setupLive();
    const c = client(accounts);
    const { postUrn } = await c.publishPost({ text: 'p', idempotencyKey: 'k' });
    const r = await c.addComment({ postUrn, text: 'Komentarz (bez escapowania) #tag', idempotencyKey: 'k:c' });
    expect(r.commentUrn).toContain(postUrn);
    const req = fake.requests.find((x) => x.path.includes('/comments'))!;
    expect(req.path).toBe(`/rest/socialActions/${encodeURIComponent(postUrn)}/comments`);
    expect(req.json).toEqual({ actor: ORG, object: postUrn, message: { text: 'Komentarz (bez escapowania) #tag' } });
  });

  it('mapowanie błędów: 401, 403, 422, 429, 5xx, timeout, zerwane połączenie, 201 bez ID', async () => {
    const { accounts } = await setupLive();
    const c = client(accounts, { timeoutMs: 500 });
    const cases: [typeof fake.behavior.posts, string, boolean][] = [
      [401, 'unauthorized', false],
      [403, 'forbidden', false],
      [422, 'rejected', false],
      [429, 'rate_limited', false],
      [500, 'ambiguous', true],
      ['hang', 'timeout', true],
      ['destroy', 'ambiguous', true],
    ];
    for (const [b, kind, amb] of cases) {
      fake.behavior.posts = b;
      await expectKind(c.publishPost({ text: 't', idempotencyKey: 'k' }), kind, amb);
    }
    fake.behavior.posts = 'ok';
    fake.behavior.postsNoHeader = true;
    await expectKind(c.publishPost({ text: 't', idempotencyKey: 'k' }), 'ambiguous', true);
  });

  it('błędy przy obrazie są zawsze jednoznaczne (post nie powstał)', async () => {
    const { accounts } = await setupLive();
    const img = { data: PNG, mime: 'image/png', sha256: 'x', bytes: 1, alt: '' };
    fake.behavior.upload = 500;
    await expectKind(client(accounts).publishPost({ text: 't', idempotencyKey: 'k', image: img }), 'network', false);
    fake.behavior.upload = 'ok';
    fake.behavior.images = 'hang';
    await expectKind(client(accounts, { timeoutMs: 300 }).publishPost({ text: 't', idempotencyKey: 'k', image: img }), 'network', false);
    expect(fake.count('POST', '/rest/posts')).toBe(0);
  });

  it('brak serwera LinkedIn (ECONNREFUSED) -> network, jednoznaczne', async () => {
    const { accounts } = await setupLive();
    await expectKind(client(accounts, { apiBase: `http://127.0.0.1:${await closedPort()}` }).publishPost({ text: 't', idempotencyKey: 'k' }), 'network', false);
  });

  it('nikt nie ma ważnego logowania -> unauthorized bez wywołań API', async () => {
    const empty = new MemAccounts();
    await expectKind(client(empty).publishPost({ text: 't', idempotencyKey: 'k' }), 'unauthorized', false);
    await empty.saveLogin(recordFor(fake.sub, ['ADMINISTRATOR'], -10));
    await expectKind(client(empty).publishPost({ text: 't', idempotencyKey: 'k' }), 'unauthorized', false);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('kilku administratorów: wybór tokenu', () => {
  it('autor posta ma pierwszeństwo; gdy jego logowanie wygasło - token innego aktywnego administratora', async () => {
    fake.addUser({ sub: 'ANNA', name: 'Anna Nowak', roles: ['CONTENT_ADMINISTRATOR'] });
    const acc = new MemAccounts();
    await acc.saveLogin(recordFor(fake.sub, ['ADMINISTRATOR']));
    await acc.saveLogin(recordFor('ANNA', ['CONTENT_ADMINISTRATOR']));
    const c = client(acc);
    expect((await c.publishPost({ text: 'a', idempotencyKey: '1', actAs: 'urn:li:person:ANNA' })).publishedBy).toBe('urn:li:person:ANNA');
    acc.recs.set('urn:li:person:ANNA', recordFor('ANNA', ['CONTENT_ADMINISTRATOR'], -60)); // logowanie Anny wygasło
    expect((await c.publishPost({ text: 'b', idempotencyKey: '2', actAs: 'urn:li:person:ANNA' })).publishedBy).toBe(`urn:li:person:${fake.sub}`);
    await acc.setVerified(`urn:li:person:${fake.sub}`, 'revoked');
    await expectKind(c.publishPost({ text: 'c', idempotencyKey: '3' }), 'unauthorized', false);
  });

  it('komentarz jako strona idzie tokenem osoby z rolą ADMINISTRATOR (CONTENT_ADMINISTRATOR nie może)', async () => {
    fake.addUser({ sub: 'ANNA', name: 'Anna Nowak', roles: ['CONTENT_ADMINISTRATOR'] });
    const acc = new MemAccounts();
    await acc.saveLogin(recordFor('ANNA', ['CONTENT_ADMINISTRATOR']));
    await acc.saveLogin(recordFor(fake.sub, ['ADMINISTRATOR']));
    const c = client(acc);
    const { postUrn, publishedBy } = await c.publishPost({ text: 'p', idempotencyKey: '1', actAs: 'urn:li:person:ANNA' });
    expect(publishedBy).toBe('urn:li:person:ANNA');
    const com = await c.addComment({ postUrn, text: 'k', idempotencyKey: '1:c', actAs: 'urn:li:person:ANNA' });
    expect(com.publishedBy).toBe(`urn:li:person:${fake.sub}`);
    expect(fake.requests.find((r) => r.path.includes('/comments'))!.as).toBe(fake.sub);
  });
});

describe('harmonogram w trybie live', () => {
  it('publikacja i komentarz jako strona; can_comment = yes; autorstwo w kolejce', async () => {
    const { clock, scheduler, store, svc } = await setupLive();
    const pv = await svc.previewSeries({ posts: [{ text: 'Post firmowy (test)', publish_at: '2026-11-06T09:00:00', comment_text: 'Komentarz', comment_delay_min: 10 }] });
    const id = (await svc.commitSeries({ plan_id: pv.plan_id })).posts[0]!.id;
    const created = (await store.getPost(id))!;
    expect(created).toMatchObject({ mode: 'live', createdBy: `urn:li:person:${fake.sub}`, createdByName: 'Szymon Warda' });
    clock.set('2026-11-06T08:00:00.000Z');
    expect((await scheduler.tick()).published).toEqual([id]);
    clock.advanceMin(10);
    expect((await scheduler.tick()).commentsDone).toEqual([id]);
    expect((await store.getPost(id))!.publishedBy).toBe(`urn:li:person:${fake.sub}`);
    expect((await store.getAuthMeta('live'))!.canComment).toBe('yes');
    const full = await svc.getPost({ id });
    expect(full).toMatchObject({ created_by: 'Szymon Warda', published_by: `urn:li:person:${fake.sub}` });
    const s = await svc.authStatus();
    expect(s).toMatchObject({ connected: true, mode: 'live', can_comment: 'yes', organization_urn: ORG, you: { name: 'Szymon Warda', roles: ['ADMINISTRATOR'] } });
    expect(s.team).toHaveLength(1);
    expect(JSON.stringify(s)).not.toContain(fake.accessToken);
  });

  it('brak uprawnień do komentarza (403) -> skipped, can_comment = no', async () => {
    const { clock, scheduler, store, svc } = await setupLive();
    fake.behavior.comments = 403;
    const pv = await svc.previewSeries({ posts: [{ text: 'Post 403', publish_at: '2026-11-06T09:00:00', comment_text: 'k', comment_delay_min: 0 }] });
    const id = (await svc.commitSeries({ plan_id: pv.plan_id })).posts[0]!.id;
    clock.set('2026-11-06T08:00:00.000Z');
    await scheduler.tick();
    await scheduler.tick();
    expect((await store.getPost(id))!.commentStatus).toBe('skipped');
    expect((await store.getAuthMeta('live'))!.canComment).toBe('no');
  });

  it('zabezpieczenie: post zatwierdzony w atracie nie zostanie wysłany przez worker live', async () => {
    const { clock, scheduler, store } = await setupLive();
    await store.savePlan({ id: 'plan_mock_1', createdAt: '2026-11-06T07:00:00.000Z', expiresAt: '2026-11-06T07:30:00.000Z', posts: [plannedPost(1, '2026-11-06T08:00:00.000Z')], committedSeriesId: null, committedAt: null });
    const { posts } = await store.commitPlan('plan_mock_1', '2026-11-06T07:00:00.000Z', (p, sid) => p.posts.map((x) => newPostFromPlanned(x, sid, 'mock')), 'ser_mock_1');
    clock.set('2026-11-06T08:00:00.000Z');
    expect((await scheduler.tick()).failed).toEqual([posts[0]!.id]);
    expect((await store.getPost(posts[0]!.id))!.lastError).toMatchObject({ code: 'mode_mismatch', ambiguous: false });
    expect(fake.count('POST', '/rest/posts')).toBe(0);
  });
});

describe('logowanie OAuth przez stronę workera (wersja lokalna)', () => {
  async function startLocal(config: Config) {
    const store = new SqliteStore(':memory:');
    cleanups.push(() => store.close());
    const accounts = new SingleAccount(createTokenStore(config));
    const ctx = createCore(config, { store, linkedin: client(accounts), auditFile: null, accounts });
    const api = await startApi(ctx, 'w'.repeat(40), createLogger({ stderr: false }), 0);
    cleanups.push(() => api.close());
    return { base: `http://127.0.0.1:${api.port}`, store };
  }
  const stateOf = async (base: string) => new URL((await fetch(`${base}/oauth/start`, { redirect: 'manual' })).headers.get('location')!).searchParams.get('state')!;

  it('start z zakresami Community Management; callback: state jednorazowy, rola sprawdzona, token zaszyfrowany', async () => {
    const config = liveConfig();
    const { base, store } = await startLocal(config);
    const start = await fetch(`${base}/oauth/start`, { redirect: 'manual' });
    const loc = new URL(start.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(`${fake.base}/oauth/v2/authorization`);
    expect(loc.searchParams.get('scope')).toBe('r_organization_admin w_organization_social');
    expect(loc.toString()).not.toContain('client-secret-xyz');
    const state = loc.searchParams.get('state')!;
    expect((await fetch(`${base}/oauth/callback?code=good-code&state=zly`)).status).toBe(401);
    expect((await fetch(`${base}/oauth/callback?code=zly-kod&state=${state}`)).status).toBe(502);
    expect((await fetch(`${base}/oauth/callback?code=good-code&state=${state}`)).status).toBe(401); // jednorazowy

    const ok = await fetch(`${base}/oauth/callback?code=good-code&state=${await stateOf(base)}`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain('Szymon Warda');
    expect(html).toContain('ADMINISTRATOR');
    expect(html).toContain(ORG);
    const rec = await createTokenStore(config).load();
    expect(rec).toMatchObject({ personUrn: `urn:li:person:${fake.sub}`, organizationUrn: ORG, roles: ['ADMINISTRATOR'] });
    expect(fs.readFileSync(config.paths.tokenStoreFile, 'utf8')).not.toContain(fake.accessToken);
    expect(JSON.stringify(await store.listAudit())).not.toContain(fake.accessToken);
  });

  it('odmowa: brak roli na stronie, rola niedozwolona, strona z innej firmy; imię bez /v2/me', async () => {
    const config = liveConfig();
    const { base } = await startLocal(config);
    fake.addUser({ sub: 'OBCY', name: 'Obcy', acls: [{ organization: 'urn:li:organization:9999', role: 'ADMINISTRATOR' }], code: 'code-obcy' });
    fake.addUser({ sub: 'ANAL', name: 'Analityk', roles: ['ANALYST'], code: 'code-anal' });
    fake.addUser({ sub: 'CADM', name: 'Content Admin', roles: ['CONTENT_ADMINISTRATOR'], code: 'code-cadm', meForbidden: true });
    const r1 = await fetch(`${base}/oauth/callback?code=code-obcy&state=${await stateOf(base)}`);
    expect(r1.status).toBe(403);
    expect(await r1.text()).toContain('nie jest administratorem strony firmy');
    const r2 = await fetch(`${base}/oauth/callback?code=code-anal&state=${await stateOf(base)}`);
    expect(r2.status).toBe(403);
    expect(await r2.text()).toContain('ANALYST');
    const r3 = await fetch(`${base}/oauth/callback?code=code-cadm&state=${await stateOf(base)}`);
    expect(r3.status).toBe(200); // CONTENT_ADMINISTRATOR może; imię nieznane (brak /v2/me) - zostaje URN
    expect(await r3.text()).toContain('urn:li:person:CADM');
  });

  it('brak LINKEDIN_ORGANIZATION_ID: komunikat z numerami stron, na których osoba ma role', async () => {
    const config = loadConfig({ ...process.env, LINKEDIN_MCP_DATA_DIR: tmpDataDir(), LINKEDIN_MODE: 'live', LINKEDIN_CLIENT_ID: 'c', LINKEDIN_CLIENT_SECRET: 's', LINKEDIN_MCP_ENC_KEY: ENC_KEY, LINKEDIN_API_BASE: fake.base, LINKEDIN_OAUTH_BASE: fake.base, LINKEDIN_ORGANIZATION_ID: '' }, { envFile: false });
    const { base } = await startLocal(config);
    const r = await fetch(`${base}/oauth/callback?code=good-code&state=${await stateOf(base)}`);
    expect(r.status).toBe(502);
    expect(await r.text()).toContain('1001');
  });
});
