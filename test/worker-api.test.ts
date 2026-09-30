import http from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, isolatedEnv, readToken, startWorkerProcess } from './process-helpers.js';
import { tmpDataDir } from './helpers.js';

let worker: ChildProcess;
let port: number;
let dataDir: string;

beforeAll(async () => {
  dataDir = tmpDataDir();
  port = await freePort();
  worker = await startWorkerProcess(isolatedEnv(dataDir, port));
});
afterAll(() => {
  worker?.kill();
});

const call = (name: string, body: unknown, token?: string) =>
  fetch(`http://127.0.0.1:${port}/api/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

function rawRequest(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/health', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('lokalne API workera', () => {
  it('health bez tokenu', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(await r.json()).toMatchObject({ ok: true, mode: 'mock' });
  });

  it('narzędzia wymagają tokenu', async () => {
    expect((await call('linkedin_list_queue', {})).status).toBe(401);
    expect((await call('linkedin_list_queue', {}, 'zly-token-zly-token-zly-token-zly-token')).status).toBe(401);
    const ok = await call('linkedin_list_queue', {}, readToken(dataDir));
    expect(await ok.json()).toEqual({ ok: true, result: { count: 0, posts: [] } });
  });

  it('błędy narzędzi wracają jako { ok: false, error: { code, message } }', async () => {
    const r = await call('linkedin_commit_series', { plan_id: 'plan_brak' }, readToken(dataDir));
    expect(await r.json()).toMatchObject({ ok: false, error: { code: 'plan_not_found' } });
    const u = await call('linkedin_publish_now', {}, readToken(dataDir));
    expect(u.status).toBe(404);
  });

  it('odrzuca obcy nagłówek Host (DNS rebinding)', async () => {
    expect(await rawRequest(`127.0.0.1:${port}`)).toBe(200);
    expect(await rawRequest(`localhost:${port}`)).toBe(200);
    expect(await rawRequest('evil.example.com')).toBe(403);
  });

  it('nie nasłuchuje na innych interfejsach niż 127.0.0.1', async () => {
    const os = await import('node:os');
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!external) return; // brak interfejsu zewnętrznego w środowisku testowym
    await expect(fetch(`http://${external.address}:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });
});
