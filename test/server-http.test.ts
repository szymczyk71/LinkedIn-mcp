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
import { FakeLinkedInServer } from './fake-linkedin-server.js';
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

/** Przepływ jak w Claude: DCR -> /authorize -> ekran zgody -> LinkedIn -> callback -> kod -> /token. */
async function connect(redirect = CLAUDE_CALLBACK) {
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', scope: 'linkedin', resource: `${base}/mcp` });
  const consent = await fetch(`${base}/authorize?${q}`);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain(new URL(redirect).host); // ekran zgody pokazuje, dokąd trafi dostęp
  const reqId = /authorize\/continue\?req=([^"&]+)/.exec(html)![1]!;
  const cont = await fetch(`${base}/authorize/continue?req=${reqId}`, { redirect: 'manual' });
  const liAuth = new URL(cont.headers.get('location')!);
  expect(liAuth.origin + liAuth.pathname).toBe(`${fake.base}/oauth/v2/authorization`);
  expect(liAuth.searchParams.get('redirect_uri')).toBe(`${base}/oauth/callback`);
  // "LinkedIn" odsyła użytkownika z kodem
  const cb = await fetch(`${base}/oauth/callback?code=good-code&state=${liAuth.searchParams.get('state')}`, { redirect: 'manual' });
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

async function mcpClient(accessToken: string) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}
const parse = (r: any) => JSON.parse(r.content[0].text);

d('server-http: wykrywanie i OAuth dla konektora Claude', () => {
  it('bez tokenu: 401 z resource_metadata; metadane zasobu i serwera autoryzacji', async () => {
    await boot();
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", error="invalid_token", scope="linkedin"`);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(prm).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: base,
      registration_endpoint: `${base}/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('pełny przepływ: kod jednorazowy z PKCE, token, narzędzia MCP; odświeżanie z rotacją i wykryciem ponownego użycia', async () => {
    await boot();
    const { client_id, verifier, cb } = await connect();
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get('state')).toBe('st-123');
    const code = back.searchParams.get('code')!;

    expect((await tokenFor(client_id, code, 'zly-verifier-' + 'x'.repeat(40))).body.error).toBe('invalid_grant');
    // kod został zużyty przy nieudanej próbie? Nie - PKCE sprawdzane po pobraniu, więc kod jest jednorazowy także wtedy:
    const t = await tokenFor(client_id, code, verifier);
    expect(t.body.error).toBe('invalid_grant');

    const second = await connect();
    const code2 = new URL(second.cb.headers.get('location')!).searchParams.get('code')!;
    const ok = await tokenFor(second.client_id, code2, second.verifier);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'linkedin' });
    expect(ok.body.refresh_token).toBeTruthy();
    expect((await tokenFor(second.client_id, code2, second.verifier)).body.error).toBe('invalid_grant'); // ponowne użycie kodu

    const client = await mcpClient(ok.body.access_token);
    const tools = (await client.listTools()).tools.map((x) => x.name);
    expect(tools).toHaveLength(9);
    expect(tools).toContain('linkedin_request_image_upload');
    const st = parse(await client.callTool({ name: 'linkedin_auth_status', arguments: {} }));
    expect(st).toMatchObject({ connected: true, mode: 'live', profile_name: 'Szymon Warda', live_login: { present: true } });
    expect(JSON.stringify(st)).not.toContain(fake.accessToken);
    await client.close();

    const refresh = async (rt: string) =>
      fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: second.client_id }),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));
    const r1 = await refresh(ok.body.refresh_token);
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(ok.body.refresh_token); // rotacja
    const reuse = await refresh(ok.body.refresh_token);
    expect(reuse.body.error).toBe('invalid_grant');
    // wykryte ponowne użycie unieważnia całą rodzinę - także nowy token dostępu
    const after = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${r1.body.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(after.status).toBe(401);
    expect((await refresh(r1.body.refresh_token)).body.error).toBe('invalid_grant');
  });

  it('odrzuca: obcy adres zwrotny przy rejestracji, brak PKCE, nieznanego klienta, konto inne niż właściciel', async () => {
    await boot();
    const bad = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/authorize?client_id=nieznany&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}`)).status).toBe(400);

    const reg = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }) })).json();
    const noPkce = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: CLAUDE_CALLBACK, state: 's' })}`, { redirect: 'manual' });
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

    await connect(); // pierwsze konto zostaje właścicielem
    expect(await core.db.getSetting('owner_person_urn')).toBe(`urn:li:person:${fake.sub}`);
    fake.sub = 'INNE_KONTO';
    const other = await connect();
    expect(other.cb.status).toBe(403);
    expect(await other.cb.text()).toContain('nie jest właścicielem');
  });

  it('loopback (Claude Code / MCP Inspector) z dowolnym portem', async () => {
    await boot();
    const reg = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost/callback'] }) })).json();
    const { challenge } = pkce();
    const r = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:6274/callback', code_challenge: challenge, code_challenge_method: 'S256' })}`);
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

d('server-http: zdjęcie przez jednorazowy link i publikacja', () => {
  it('link -> strona -> PUT pliku -> image_id w podglądzie -> publikacja z obrazem na LinkedIn', async () => {
    await boot();
    const { cb, client_id, verifier } = await connect();
    const tok = await tokenFor(client_id, new URL(cb.headers.get('location')!).searchParams.get('code')!, verifier);
    const client = await mcpClient(tok.body.access_token);

    const up = parse(await client.callTool({ name: 'linkedin_request_image_upload', arguments: {} }));
    expect(up.image_id).toMatch(/^img_/);
    expect(up.upload_url.startsWith(`${base}/upload/`)).toBe(true);

    const pending = await client.callTool({ name: 'linkedin_preview_series', arguments: { posts: [{ text: 'Post z grafiką', publish_at: '2099-01-05T09:00:00', image_id: up.image_id }] } });
    expect(parse(pending).posts[0].errors.join()).toMatch(/nie zostało jeszcze przesłane/);

    const form = await fetch(up.upload_url);
    expect(form.status).toBe(200);
    expect(form.headers.get('content-security-policy')).toContain("script-src 'nonce-");
    const bad = await fetch(up.upload_url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from('to nie obraz') });
    expect(bad.status).toBe(400);
    const put = await fetch(up.upload_url, { method: 'PUT', headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('grafika NIS2.png') }, body: PNG });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ image_id: up.image_id, width: 1, height: 1 });
    expect((await fetch(up.upload_url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG })).status).toBe(410); // jednorazowy
    expect((await fetch(up.upload_url)).status).toBe(410);

    // image_path na serwerze jest odrzucane (serwer nie czyta ścieżek z własnego dysku)
    const tmp = path.join(tmpDataDir(), 'x.png');
    fs.writeFileSync(tmp, PNG);
    const withPath = parse(await client.callTool({ name: 'linkedin_preview_series', arguments: { posts: [{ text: 'Ścieżka', publish_at: '2099-01-05T10:00:00', image_path: tmp }] } }));
    expect(withPath.posts[0].errors.join()).toMatch(/nie ma dostępu do plików/);

    const publishAt = new Date(clock.now().getTime() + 20 * 60_000);
    const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(publishAt).replace(' ', 'T');
    const pv = parse(await client.callTool({ name: 'linkedin_preview_series', arguments: { posts: [{ text: 'Post z grafiką #NIS2', publish_at: local, image_id: up.image_id, image_alt: 'Schemat', comment_text: 'Komentarz', comment_delay_min: 0 }] } }));
    expect(pv.posts[0].image).toMatchObject({ file_name: 'grafika NIS2.png', mime: 'image/png', alt: 'Schemat' });
    const committed = parse(await client.callTool({ name: 'linkedin_commit_series', arguments: { plan_id: pv.plan_id } }));
    await client.close();

    clock.advanceMin(30);
    const sched = new Scheduler(core);
    expect((await sched.tick()).published).toEqual([committed.posts[0].id]);
    await sched.tick();
    const put2 = fake.requests.find((r) => r.method === 'PUT')!;
    expect(put2.body.equals(PNG)).toBe(true);
    const post = fake.requests.find((r) => r.path === '/rest/posts')!;
    expect(post.json).toMatchObject({ commentary: 'Post z grafiką #NIS2', content: { media: { altText: 'Schemat' } } });
    expect((await core.store.getPost(committed.posts[0].id))!.commentStatus).toBe('done');
  });

  it('bezpiecznik w bazie wstrzymuje publikację', async () => {
    await boot();
    await core.pause.set('test');
    expect((await new Scheduler(core).tick()).paused).toBe(true);
  });
});
