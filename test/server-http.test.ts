import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { FakeClock, Scheduler, createLogger, loadConfig } from '../src/core/index.js';
import { startHttpApp, type HttpApp } from '../src/server-http/app.js';
import { CLAUDE_CALLBACK } from '../src/server-http/oauth-server.js';
import { openServerCore, type ServerCore } from '../src/server-http/core.js';
import { FakeLinkedInServer, ORG } from './fake-linkedin-server.js';
import { tmpDataDir } from './helpers.js';
import { freePort } from './process-helpers.js';

const pgUrl = inject('pgUrl');
const d = pgUrl ? describe : describe.skip;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let fake: FakeLinkedInServer;
let core: ServerCore;
let app: HttpApp;
let base: string;
let clock: FakeClock;

async function boot(env: Record<string, string> = {}) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const config = loadConfig(
    {
      LINKEDIN_MCP_DATA_DIR: tmpDataDir(),
      LINKEDIN_MODE: 'live',
      LINKEDIN_CLIENT_ID: 'li-client',
      LINKEDIN_CLIENT_SECRET: 'li-secret-xyz',
      LINKEDIN_MCP_ENC_KEY: crypto.randomBytes(32).toString('base64'),
      LINKEDIN_API_BASE: fake.base,
      LINKEDIN_OAUTH_BASE: fake.base,
      LINKEDIN_ORGANIZATION_ID: '1001',
      LINKEDIN_ORGANIZATION_NAME: 'KTBnet',
      PUBLIC_BASE_URL: base,
      DATABASE_URL: pgUrl!,
      ...env,
    },
    { envFile: false },
  );
  clock = new FakeClock(new Date());
  core = await openServerCore(config, { clock, pgSchema: `s_${crypto.randomBytes(5).toString('hex')}` });
  app = await startHttpApp(core, createLogger({ stderr: false }), { port, host: '127.0.0.1' });
}

beforeEach(async () => {
  fake = new FakeLinkedInServer();
  await fake.start();
});
afterEach(async () => {
  await app?.close();
  await core?.db.close();
  await fake.stop();
});

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

/** Przepływ jak w Claude: DCR -> /authorize -> ekran zgody -> LinkedIn (kod danej osoby) -> callback. */
async function connect(liCode = 'good-code', redirect = CLAUDE_CALLBACK) {
  const reg = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }) });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', scope: 'linkedin', resource: `${base}/mcp` });
  const consent = await fetch(`${base}/authorize?${q}`);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain(new URL(redirect).host);
  const reqId = /authorize\/continue\?req=([^"&]+)/.exec(html)![1]!;
  const cont = await fetch(`${base}/authorize/continue?req=${reqId}`, { redirect: 'manual' });
  const liAuth = new URL(cont.headers.get('location')!);
  expect(liAuth.searchParams.get('scope')).toBe('r_organization_admin w_organization_social');
  const cb = await fetch(`${base}/oauth/callback?code=${liCode}&state=${liAuth.searchParams.get('state')}`, { redirect: 'manual' });
  return { client_id, verifier, cb };
}

async function tokenFor(client_id: string, code: string, verifier: string) {
  const r = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: CLAUDE_CALLBACK }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

/** Pełne połączenie konektora dla osoby: zwraca tokeny konektora. */
async function login(liCode = 'good-code') {
  const c = await connect(liCode);
  expect(c.cb.status).toBe(302);
  const t = await tokenFor(c.client_id, new URL(c.cb.headers.get('location')!).searchParams.get('code')!, c.verifier);
  expect(t.status).toBe(200);
  return { ...t.body, client_id: c.client_id } as { access_token: string; refresh_token: string; client_id: string };
}

const refresh = (client_id: string, rt: string) =>
  fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id }) }).then(
    async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }),
  );

const mcpStatus = (accessToken: string) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then((r) => r.status);

async function mcpClient(accessToken: string) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}
const parse = (r: any) => JSON.parse(r.content[0].text);
const localIn = (min: number) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(clock.now().getTime() + min * 60_000))
    .replace(' ', 'T');

d('server-http: wykrywanie i OAuth dla konektora Claude', () => {
  it('bez tokenu: 401 z resource_metadata; metadane zasobu i serwera autoryzacji', async () => {
    await boot();
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", error="invalid_token", scope="linkedin"`);
    expect(await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    expect(await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
      issuer: base,
      registration_endpoint: `${base}/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('kod jednorazowy z PKCE, narzędzia MCP, rotacja odświeżania z wykryciem ponownego użycia', async () => {
    await boot();
    const c = await connect();
    const back = new URL(c.cb.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get('state')).toBe('st-123');
    const code = back.searchParams.get('code')!;
    expect((await tokenFor(c.client_id, code, 'zly-verifier-' + 'x'.repeat(40))).body.error).toBe('invalid_grant');
    expect((await tokenFor(c.client_id, code, c.verifier)).body.error).toBe('invalid_grant'); // kod zużyty

    const ok = await login();
    const client = await mcpClient(ok.access_token);
    expect((await client.listTools()).tools).toHaveLength(9);
    const st = parse(await client.callTool({ name: 'linkedin_auth_status', arguments: {} }));
    expect(st).toMatchObject({ connected: true, mode: 'live', profile_name: 'KTBnet', organization_urn: ORG, you: { name: 'Szymon Warda', roles: ['ADMINISTRATOR'] } });
    expect(JSON.stringify(st)).not.toContain(fake.accessToken);
    await client.close();

    const r1 = await refresh(ok.client_id, ok.refresh_token);
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(ok.refresh_token);
    expect((await refresh(ok.client_id, ok.refresh_token)).body.error).toBe('invalid_grant'); // ponowne użycie
    expect(await mcpStatus(r1.body.access_token)).toBe(401); // cała rodzina unieważniona
  });

  it('dostęp według roli na stronie: ADMINISTRATOR i CONTENT_ADMINISTRATOR tak; ANALYST i inna strona nie', async () => {
    await boot();
    const anna = fake.addUser({ sub: 'ANNA', name: 'Anna Nowak', roles: ['CONTENT_ADMINISTRATOR'] });
    const anal = fake.addUser({ sub: 'ANAL', name: 'Analityk', roles: ['ANALYST'] });
    const obcy = fake.addUser({ sub: 'OBCY', name: 'Obcy', acls: [{ organization: 'urn:li:organization:9999', role: 'ADMINISTRATOR' }] });
    expect((await connect()).cb.status).toBe(302);
    expect((await connect(anna)).cb.status).toBe(302);
    const r1 = await connect(anal);
    expect(r1.cb.status).toBe(403);
    expect(await r1.cb.text()).toContain('ANALYST');
    expect((await connect(obcy)).cb.status).toBe(403);
    const users = await core.db.listUsers();
    expect(users.map((u) => [u.name, u.roles, u.status])).toEqual([
      ['Szymon Warda', ['ADMINISTRATOR'], 'active'],
      ['Anna Nowak', ['CONTENT_ADMINISTRATOR'], 'active'],
    ]);
  });

  it('odebranie roli na LinkedIn: przy odświeżeniu tokenu dostęp znika; zablokowane konto nie zaloguje się', async () => {
    await boot();
    const annaCode = fake.addUser({ sub: 'ANNA', name: 'Anna Nowak', roles: ['CONTENT_ADMINISTRATOR'] });
    const anna = await login(annaCode);
    expect(await mcpStatus(anna.access_token)).toBe(200);
    fake.user('ANNA').acls = []; // ktoś odebrał Annie rolę na stronie
    const r = await refresh(anna.client_id, anna.refresh_token);
    expect(r.body.error).toBe('invalid_grant');
    expect((await core.db.getUser('urn:li:person:ANNA'))!.status).toBe('revoked');
    expect(await mcpStatus(anna.access_token)).toBe(401);

    const szymon = await login();
    expect(await core.db.setUserStatus(`urn:li:person:${fake.sub}`, 'blocked', null, new Date().toISOString())).toBe(true);
    expect(await mcpStatus(szymon.access_token)).toBe(401); // zablokowany od razu traci dostęp
    const blocked = await connect();
    expect(blocked.cb.status).toBe(403);
    expect(await blocked.cb.text()).toContain('zablokowane');
  });

  it('odrzuca obcy adres zwrotny, brak PKCE i nieznanego klienta; loopback z dowolnym portem działa', async () => {
    await boot();
    expect((await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) })).status).toBe(400);
    expect((await fetch(`${base}/authorize?client_id=nieznany&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}`)).status).toBe(400);
    const reg = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }) })).json();
    const noPkce = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: CLAUDE_CALLBACK, state: 's' })}`, { redirect: 'manual' });
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

    const lb = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost/callback'] }) })).json();
    const { challenge } = pkce();
    const r = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: lb.client_id, redirect_uri: 'http://localhost:6274/callback', code_challenge: challenge, code_challenge_method: 'S256' })}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('adres lokalny');
  });

  it('limit zapytań na endpointach OAuth', async () => {
    await boot({ RATE_LIMIT_PER_MIN: '40' });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
    expect(codes).toContain(429);
  });
});

d('server-http: zespół, wspólna kolejka, publikacja jako strona', () => {
  it('dwie osoby: wspólna kolejka z autorstwem; post Anny publikuje Anna, komentarz idzie tokenem ADMINISTRATORA', async () => {
    await boot();
    const szymon = await login();
    const anna = await login(fake.addUser({ sub: 'ANNA', name: 'Anna Nowak', roles: ['CONTENT_ADMINISTRATOR'] }));
    const ca = await mcpClient(anna.access_token);
    const cs = await mcpClient(szymon.access_token);

    const pv = parse(await ca.callTool({ name: 'linkedin_preview_series', arguments: { posts: [{ text: 'Post od Anny #KTBnet', publish_at: localIn(20), comment_text: 'Komentarz firmowy', comment_delay_min: 10 }] } }));
    const id = parse(await ca.callTool({ name: 'linkedin_commit_series', arguments: { plan_id: pv.plan_id } })).posts[0].id;

    const queue = parse(await cs.callTool({ name: 'linkedin_list_queue', arguments: {} }));
    expect(queue.posts.map((p: any) => p.id)).toEqual([id]); // Szymon widzi post Anny
    const upd = parse(await cs.callTool({ name: 'linkedin_update_post', arguments: { id, text: 'Post od Anny #KTBnet (poprawiony)' } }));
    expect(upd).toMatchObject({ created_by: 'Anna Nowak', updated_by: 'Szymon Warda' });
    const st = parse(await ca.callTool({ name: 'linkedin_auth_status', arguments: {} }));
    expect(st.you).toMatchObject({ name: 'Anna Nowak', roles: ['CONTENT_ADMINISTRATOR'] });
    expect(st.team.map((t: any) => t.name).sort()).toEqual(['Anna Nowak', 'Szymon Warda']);
    await ca.close();
    await cs.close();

    clock.advanceMin(30);
    const sched = new Scheduler(core);
    expect((await sched.tick()).published).toEqual([id]);
    const postReq = fake.requests.find((r) => r.path === '/rest/posts')!;
    expect(postReq.json.author).toBe(ORG);
    expect(postReq.as).toBe('ANNA');
    clock.advanceMin(10);
    expect((await sched.tick()).commentsDone).toEqual([id]);
    const comReq = fake.requests.find((r) => r.path.includes('/comments'))!;
    expect(comReq.json.actor).toBe(ORG);
    expect(comReq.as).toBe(fake.sub); // CONTENT_ADMINISTRATOR nie komentuje jako strona
    expect((await core.store.getPost(id))!.publishedBy).toBe('urn:li:person:ANNA');
  });

  it('logowanie autora wygasło: post wychodzi tokenem innego administratora', async () => {
    await boot();
    await login();
    const anna = await login(fake.addUser({ sub: 'ANNA', name: 'Anna Nowak', roles: ['ADMINISTRATOR'] }));
    const ca = await mcpClient(anna.access_token);
    const pv = parse(await ca.callTool({ name: 'linkedin_preview_series', arguments: { posts: [{ text: 'Post po urlopie Anny', publish_at: localIn(20) }] } }));
    const id = parse(await ca.callTool({ name: 'linkedin_commit_series', arguments: { plan_id: pv.plan_id } })).posts[0].id;
    await ca.close();
    const rec = (await core.accounts.get('urn:li:person:ANNA'))!;
    await core.accounts.saveLogin({ ...rec, expiresAt: new Date(clock.now().getTime() - 60_000).toISOString() }, clock.now().toISOString());
    clock.advanceMin(30);
    expect((await new Scheduler(core).tick()).published).toEqual([id]);
    expect(fake.requests.find((r) => r.path === '/rest/posts')!.as).toBe(fake.sub);
    expect((await core.store.getPost(id))!.publishedBy).toBe(`urn:li:person:${fake.sub}`);
  });

  it('zdjęcie przez jednorazowy link -> publikacja z obrazem jako strona', async () => {
    await boot();
    const t = await login();
    const client = await mcpClient(t.access_token);
    const up = parse(await client.callTool({ name: 'linkedin_request_image_upload', arguments: {} }));
    expect(up.upload_url.startsWith(`${base}/upload/`)).toBe(true);
    const pending = parse(await client.callTool({ name: 'linkedin_preview_series', arguments: { posts: [{ text: 'Grafika', publish_at: '2099-01-05T09:00:00', image_id: up.image_id }] } }));
    expect(pending.posts[0].errors.join()).toMatch(/nie zostało jeszcze przesłane/);
    const form = await fetch(up.upload_url);
    expect(form.headers.get('content-security-policy')).toContain("script-src 'nonce-");
    expect((await fetch(up.upload_url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from('nie obraz') })).status).toBe(400);
    const put = await fetch(up.upload_url, { method: 'PUT', headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('grafika NIS2.png') }, body: PNG });
    expect(await put.json()).toMatchObject({ image_id: up.image_id, width: 1 });
    expect((await fetch(up.upload_url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG })).status).toBe(410);

    const tmp = path.join(tmpDataDir(), 'x.png');
    fs.writeFileSync(tmp, PNG);
    const withPath = parse(await client.callTool({ name: 'linkedin_preview_series', arguments: { posts: [{ text: 'Ścieżka', publish_at: '2099-01-05T10:00:00', image_path: tmp }] } }));
    expect(withPath.posts[0].errors.join()).toMatch(/nie ma dostępu do plików/);

    const pv = parse(await client.callTool({ name: 'linkedin_preview_series', arguments: { posts: [{ text: 'Post z grafiką #NIS2', publish_at: localIn(20), image_id: up.image_id, image_alt: 'Schemat' }] } }));
    expect(pv.posts[0].image).toMatchObject({ file_name: 'grafika NIS2.png', alt: 'Schemat' });
    const id = parse(await client.callTool({ name: 'linkedin_commit_series', arguments: { plan_id: pv.plan_id } })).posts[0].id;
    await client.close();
    clock.advanceMin(30);
    expect((await new Scheduler(core).tick()).published).toEqual([id]);
    expect(fake.requests.find((r) => r.path.startsWith('/rest/images?action=initializeUpload'))!.json).toEqual({ initializeUploadRequest: { owner: ORG } });
    expect(fake.requests.find((r) => r.method === 'PUT')!.body.equals(PNG)).toBe(true);
    expect(fake.requests.find((r) => r.path === '/rest/posts')!.json).toMatchObject({ author: ORG, content: { media: { altText: 'Schemat' } } });
  });

  it('bezpiecznik w bazie wstrzymuje publikację', async () => {
    await boot();
    await core.pause.set('test');
    expect((await new Scheduler(core).tick()).paused).toBe(true);
  });
});
