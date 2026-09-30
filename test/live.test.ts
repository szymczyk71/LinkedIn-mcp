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
  SqliteStore,
  StaticKeyProvider,
  TokenStore,
  createCore,
  createLogger,
  createTokenStore,
  escapeLittle,
  extractHashtags,
  loadConfig,
  saveLogin,
  type Config,
  type CoreContext,
} from '../src/core/index.js';
import { newPostFromPlanned } from '../src/core/posts.js';
import { startApi } from '../src/worker/api.js';
import { FakeLinkedInServer } from './fake-linkedin-server.js';
import { plannedPost, tmpDataDir } from './helpers.js';

const ENC_KEY = crypto.randomBytes(32).toString('base64');

async function closedPort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as import('node:net').AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}
let fake: FakeLinkedInServer;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

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
      LINKEDIN_POST_VISIBILITY: 'CONNECTIONS',
      ...extra,
    },
    { envFile: false },
  );
}

async function loggedIn(config: Config, store: SqliteStore) {
  await saveLogin(createTokenStore(config), store, { accessToken: fake.accessToken, expiresInSec: 60 * 86_400, scopes: ['openid', 'profile', 'w_member_social'] }, { sub: fake.sub, name: fake.name }, 'oauth');
}

function client(config: Config, opts: Partial<ConstructorParameters<typeof LiveLinkedIn>[0]> = {}) {
  return new LiveLinkedIn({
    tokens: createTokenStore(config),
    apiBase: config.linkedin.apiBase,
    apiVersion: config.linkedin.apiVersion,
    visibility: config.linkedin.visibility,
    imageReadyTimeoutMs: 3000,
    ...opts,
  });
}

async function setupLive(extra: Record<string, string> = {}) {
  const config = liveConfig(extra);
  const store = new SqliteStore(':memory:');
  cleanups.push(() => store.close());
  await loggedIn(config, store);
  const clock = new FakeClock('2026-11-06T07:00:00.000Z');
  const li = client(config);
  const ctx: CoreContext = createCore(config, { store, linkedin: li, clock, auditFile: null });
  return { config, store, clock, li, ctx, svc: new LinkedInService(ctx), scheduler: new Scheduler(ctx) };
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
    const rec = {
      accessToken: 'SEKRETNY_TOKEN_123',
      refreshToken: null,
      expiresAt: '2026-12-01T00:00:00.000Z',
      refreshTokenExpiresAt: null,
      scopes: ['w_member_social'],
      personUrn: 'urn:li:person:x',
      profileName: 'X',
      obtainedAt: '2026-10-01T00:00:00.000Z',
      source: 'oauth' as const,
    };
    await ts.save(rec);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('SEKRETNY_TOKEN_123');
    expect(await ts.load()).toEqual(rec);
    expect((await ts.info()).present).toBe(true);
    expect(JSON.stringify(await ts.info())).not.toContain('SEKRETNY');
    await expect(new TokenStore(file, new StaticKeyProvider(crypto.randomBytes(32))).load()).rejects.toThrow(/odszyfrować/);
    expect(await ts.clear()).toBe(true);
    expect(await ts.load()).toBeNull();
  });
});

describe('LiveLinkedIn (atrapa serwera HTTP)', () => {
  it('publikacja: endpoint, nagłówki wersji, autor z userinfo, commentary w formacie little, widoczność', async () => {
    const { config, store } = await setupLive();
    const r = await client(config).publishPost({ text: 'Test (1) #NIS2 @ktoś', idempotencyKey: 'k' });
    expect(r.postUrn).toMatch(/^urn:li:share:\d+$/);
    expect(r.postUrl).toBe(`https://www.linkedin.com/feed/update/${r.postUrn}/`);
    const req = fake.requests.find((x) => x.path === '/rest/posts')!;
    expect(req.headers['linkedin-version']).toBe('202609');
    expect(req.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(req.json).toEqual({
      author: `urn:li:person:${fake.sub}`,
      commentary: 'Test \\(1\\) #NIS2 \\@ktoś',
      visibility: 'CONNECTIONS',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
    expect((await store.getAuthMeta('live'))!.personUrn).toBe(`urn:li:person:${fake.sub}`);
  });

  it('obraz: initializeUpload (owner=person), PUT z tokenem, status, post z content.media i altText', async () => {
    const { config } = await setupLive();
    const file = path.join(tmpDataDir(), 'a.png');
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(file, bytes);
    await client(config).publishPost({ text: 'Z obrazem', idempotencyKey: 'k', image: { data: bytes, mime: 'image/png', sha256: 'x', bytes: bytes.length, alt: 'Opis' } });
    const init = fake.requests.find((x) => x.path.startsWith('/rest/images?action=initializeUpload'))!;
    expect(init.json).toEqual({ initializeUploadRequest: { owner: `urn:li:person:${fake.sub}` } });
    const put = fake.requests.find((x) => x.method === 'PUT')!;
    expect(put.headers.authorization).toBe(`Bearer ${fake.accessToken}`);
    expect(put.body.equals(bytes)).toBe(true);
    const post = fake.requests.find((x) => x.path === '/rest/posts')!;
    expect(post.json.content).toEqual({ media: { id: expect.stringMatching(/^urn:li:image:/), altText: 'Opis' } });
  });

  it('obraz: 403 przy sprawdzaniu statusu (tylko w_member_social) -> krótkie czekanie i publikacja', async () => {
    const { config } = await setupLive();
    fake.behavior.imageStatus = 403;
    const file = path.join(tmpDataDir(), 'b.gif');
    fs.writeFileSync(file, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    await expect(client(config).publishPost({ text: 'x', idempotencyKey: 'k', image: { data: fs.readFileSync(file), mime: 'image/gif', sha256: 'x', bytes: 1, alt: '' } })).resolves.toBeTruthy();
  });

  it('komentarz: socialActions z zakodowanym URN, actor/object/message', async () => {
    const { config } = await setupLive();
    const c = client(config);
    const { postUrn } = await c.publishPost({ text: 'p', idempotencyKey: 'k' });
    const r = await c.addComment({ postUrn, text: 'Komentarz (bez escapowania) #tag', idempotencyKey: 'k:c' });
    expect(r.commentUrn).toContain(postUrn);
    const req = fake.requests.find((x) => x.path.includes('/comments'))!;
    expect(req.path).toBe(`/rest/socialActions/${encodeURIComponent(postUrn)}/comments`);
    expect(req.json).toEqual({ actor: `urn:li:person:${fake.sub}`, object: postUrn, message: { text: 'Komentarz (bez escapowania) #tag' } });
  });

  it('mapowanie błędów: 401, 403, 422, 429, 5xx, timeout, zerwane połączenie, brak serwera, 201 bez ID', async () => {
    const { config } = await setupLive();
    const c = client(config, { timeoutMs: 500 });
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
    const { config } = await setupLive();
    const file = path.join(tmpDataDir(), 'c.png');
    fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    const img = { data: fs.readFileSync(file), mime: 'image/png', sha256: 'x', bytes: 1, alt: '' };
    fake.behavior.upload = 500;
    await expectKind(client(config).publishPost({ text: 't', idempotencyKey: 'k', image: img }), 'network', false);
    fake.behavior.upload = 'ok';
    fake.behavior.images = 'hang';
    await expectKind(client(config, { timeoutMs: 300 }).publishPost({ text: 't', idempotencyKey: 'k', image: img }), 'network', false);
    expect(fake.count('POST', '/rest/posts')).toBe(0);
  });

  it('brak serwera LinkedIn (ECONNREFUSED) -> network, jednoznaczne', async () => {
    const config = liveConfig({ LINKEDIN_API_BASE: `http://127.0.0.1:${await closedPort()}` });
    const store = new SqliteStore(':memory:');
    cleanups.push(() => store.close());
    await loggedIn(config, store);
    await expectKind(client(config).publishPost({ text: 't', idempotencyKey: 'k' }), 'network', false);
  });

  it('brak lub wygasły token -> unauthorized bez wywołań API', async () => {
    const config = liveConfig();
    await expectKind(client(config).publishPost({ text: 't', idempotencyKey: 'k' }), 'unauthorized', false);
    const store = new SqliteStore(':memory:');
    cleanups.push(() => store.close());
    await saveLogin(createTokenStore(config), store, { accessToken: fake.accessToken, expiresInSec: -10, scopes: [] }, { sub: 's', name: null }, 'oauth');
    await expectKind(client(config).publishPost({ text: 't', idempotencyKey: 'k' }), 'unauthorized', false);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('harmonogram w trybie live', () => {
  it('publikacja i komentarz przez API; can_comment (live) = yes', async () => {
    const { ctx, clock, scheduler, store, svc } = await setupLive();
    const pv = await svc.previewSeries({ posts: [{ text: 'Post live (test)', publish_at: '2026-11-06T09:00:00', comment_text: 'Komentarz live', comment_delay_min: 2 }] });
    const id = (await svc.commitSeries({ plan_id: pv.plan_id })).posts[0]!.id;
    expect((await store.getPost(id))!.mode).toBe('live');
    clock.set('2026-11-06T08:00:00.000Z');
    expect((await scheduler.tick()).published).toEqual([id]);
    clock.advanceMin(5);
    expect((await scheduler.tick()).commentsDone).toEqual([id]);
    expect((await store.getAuthMeta('live'))!.canComment).toBe('yes');
    const s = await svc.authStatus();
    expect(s).toMatchObject({ connected: true, mode: 'live', can_comment: 'yes', profile_name: 'Szymon Warda', post_visibility: 'CONNECTIONS', live_login: { present: true } });
    expect(JSON.stringify(s)).not.toContain(fake.accessToken);
    void ctx;
  });

  it('brak uprawnień do komentarza (403) -> skipped, can_comment (live) = no', async () => {
    const { clock, scheduler, store, svc } = await setupLive();
    fake.behavior.comments = 403;
    const pv = await svc.previewSeries({ posts: [{ text: 'Post 403', publish_at: '2026-11-06T09:00:00', comment_text: 'k', comment_delay_min: 0 }] });
    const id = (await svc.commitSeries({ plan_id: pv.plan_id })).posts[0]!.id;
    clock.set('2026-11-06T08:00:00.000Z');
    await scheduler.tick();
    await scheduler.tick();
    expect((await store.getPost(id))!.commentStatus).toBe('skipped');
    expect((await store.getAuthMeta('live'))!.canComment).toBe('no');
    expect((await store.getAuthMeta('mock'))).toBeNull();
  });

  it('zabezpieczenie: post zatwierdzony w atracie nie zostanie wysłany przez worker live', async () => {
    const { ctx, clock, scheduler, store } = await setupLive();
    const planId = 'plan_mock_1';
    await store.savePlan({ id: planId, createdAt: '2026-11-06T07:00:00.000Z', expiresAt: '2026-11-06T07:30:00.000Z', posts: [plannedPost(1, '2026-11-06T08:00:00.000Z')], committedSeriesId: null, committedAt: null });
    const { posts } = await store.commitPlan(planId, '2026-11-06T07:00:00.000Z', (p, sid) => p.posts.map((x) => newPostFromPlanned(x, sid, 'mock')), 'ser_mock_1');
    clock.set('2026-11-06T08:00:00.000Z');
    expect((await scheduler.tick()).failed).toEqual([posts[0]!.id]);
    expect((await store.getPost(posts[0]!.id))!.lastError).toMatchObject({ code: 'mode_mismatch', ambiguous: false });
    expect(fake.count('POST', '/rest/posts')).toBe(0);
    void ctx;
  });
});

describe('logowanie OAuth przez stronę workera', () => {
  it('start -> przekierowanie z state; callback: zły state 401, dobry kod -> zaszyfrowany token', async () => {
    const config = liveConfig();
    const store = new SqliteStore(':memory:');
    cleanups.push(() => store.close());
    const ctx = createCore(config, { store, linkedin: client(config), auditFile: null });
    const api = await startApi(ctx, 'w'.repeat(40), createLogger({ stderr: false }), 0);
    cleanups.push(() => api.close());
    const base = `http://127.0.0.1:${api.port}`;

    const start = await fetch(`${base}/oauth/start`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(`${fake.base}/oauth/v2/authorization`);
    expect(loc.searchParams.get('response_type')).toBe('code');
    expect(loc.searchParams.get('client_id')).toBe('client-id-123');
    expect(loc.searchParams.get('redirect_uri')).toBe(config.linkedin.redirectUri);
    expect(loc.searchParams.get('scope')).toBe('openid profile w_member_social');
    const state = loc.searchParams.get('state')!;
    expect(state.length).toBeGreaterThan(20);
    expect(loc.toString()).not.toContain('client-secret-xyz');

    expect((await fetch(`${base}/oauth/callback?code=good-code&state=zly`)).status).toBe(401);
    const bad = await fetch(`${base}/oauth/callback?code=zly-kod&state=${state}`);
    expect(bad.status).toBe(502);
    expect((await fetch(`${base}/oauth/callback?code=good-code&state=${state}`)).status).toBe(401); // state jednorazowy

    const start2 = await fetch(`${base}/oauth/start`, { redirect: 'manual' });
    const state2 = new URL(start2.headers.get('location')!).searchParams.get('state')!;
    const ok = await fetch(`${base}/oauth/callback?code=good-code&state=${state2}`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain('Szymon Warda');
    expect(html).not.toContain(fake.accessToken);

    const tokenReq = fake.requests.find((r) => r.path === '/oauth/v2/accessToken' && r.body.toString().includes('good-code'))!;
    const form = new URLSearchParams(tokenReq.body.toString());
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', client_id: 'client-id-123', redirect_uri: config.linkedin.redirectUri });

    const rec = await createTokenStore(config).load();
    expect(rec).toMatchObject({ personUrn: `urn:li:person:${fake.sub}`, profileName: 'Szymon Warda', source: 'oauth', scopes: ['openid', 'profile', 'w_member_social'] });
    expect(fs.readFileSync(config.paths.tokenStoreFile, 'utf8')).not.toContain(fake.accessToken);
    const audit = JSON.stringify(await store.listAudit());
    expect(audit).toContain('oauth_login');
    expect(audit).not.toContain(fake.accessToken);
    expect(audit).not.toContain('client-secret-xyz');
  });

  it('anulowanie logowania i brak konfiguracji aplikacji', async () => {
    const config = liveConfig();
    const store = new SqliteStore(':memory:');
    cleanups.push(() => store.close());
    const api = await startApi(createCore(config, { store, linkedin: client(config), auditFile: null }), 'w'.repeat(40), createLogger({ stderr: false }), 0);
    cleanups.push(() => api.close());
    const base = `http://127.0.0.1:${api.port}`;
    const st = new URL((await fetch(`${base}/oauth/start`, { redirect: 'manual' })).headers.get('location')!).searchParams.get('state');
    const cancel = await fetch(`${base}/oauth/callback?error=user_cancelled_authorize&state=${st}`);
    expect(cancel.status).toBe(400);
    expect(await cancel.text()).toContain('anulowane');

    const noClient = loadConfig({ LINKEDIN_MCP_DATA_DIR: tmpDataDir(), LINKEDIN_MCP_ENC_KEY: ENC_KEY }, { envFile: false });
    const store2 = new SqliteStore(':memory:');
    cleanups.push(() => store2.close());
    const api2 = await startApi(createCore(noClient, { store: store2, auditFile: null }), 'w'.repeat(40), createLogger({ stderr: false }), 0);
    cleanups.push(() => api2.close());
    const r = await fetch(`http://127.0.0.1:${api2.port}/oauth/start`, { redirect: 'manual' });
    expect(r.status).toBe(500);
    expect(await r.text()).toContain('LINKEDIN_CLIENT_ID');
  });
});
