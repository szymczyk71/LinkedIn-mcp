import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT, SqliteStore, newId, type Post } from '../src/core/index.js';
import { plannedPost, tmpDataDir, toNewPost } from './helpers.js';

const WORKER = path.join(PACKAGE_ROOT, 'dist', 'worker', 'index.js');
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill();
});

function startWorker(dataDir: string): ChildProcess {
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, LINKEDIN_MCP_DATA_DIR: dataDir, LINKEDIN_MCP_ENV_FILE: path.join(dataDir, 'none.env'), LINKEDIN_MODE: 'mock' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  return child;
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Przekroczono czas oczekiwania');
}

async function seed(dbFile: string, publishAtUtc: string, count: number): Promise<Post[]> {
  const store = new SqliteStore(dbFile);
  const now = new Date().toISOString();
  const planId = newId('plan');
  const posts = Array.from({ length: count }, (_, i) => plannedPost(i + 1, publishAtUtc));
  await store.savePlan({ id: planId, createdAt: now, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), posts, committedSeriesId: null, committedAt: null });
  const res = await store.commitPlan(planId, now, (p, sid) => p.posts.map((x) => toNewPost(x, sid)), newId('ser'));
  await store.close();
  return res.posts;
}

async function readPost(dbFile: string, id: string): Promise<Post> {
  const store = new SqliteStore(dbFile);
  try {
    return (await store.getPost(id))!;
  } finally {
    await store.close();
  }
}

describe('proces workera', () => {
  it('restart w trakcie publikacji: przerwany post -> failed, reszta publikuje się po restarcie, bez duplikatów', async () => {
    const dataDir = tmpDataDir();
    const dbFile = path.join(dataDir, 'linkedin-mcp.db');
    const scenarioFile = path.join(dataDir, 'mock-scenario.json');
    const stateFile = path.join(dataDir, 'mock-linkedin.json');
    const [p1, p2] = await seed(dbFile, new Date(Date.now() - 60_000).toISOString(), 2);

    // Atrapa odpowiada wolno, żeby dało się zabić proces w trakcie publikacji.
    fs.writeFileSync(scenarioFile, JSON.stringify({ delayMs: 10_000 }));
    const first = startWorker(dataDir);
    await waitFor(async () => (await readPost(dbFile, p1!.id)).status === 'publishing');
    first.kill('SIGKILL');
    await new Promise((r) => first.once('exit', r));

    fs.writeFileSync(scenarioFile, JSON.stringify({}));
    const second = startWorker(dataDir);
    const recovered = await waitFor(async () => {
      const p = await readPost(dbFile, p1!.id);
      return p.status === 'failed' ? p : null;
    });
    expect(recovered.lastError).toMatchObject({ code: 'publish_interrupted', ambiguous: true });

    const published = await waitFor(async () => {
      const p = await readPost(dbFile, p2!.id);
      return p.status === 'published' ? p : null;
    });
    expect(published.postUrl).toBeTruthy();

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { posts: { idempotencyKey: string }[] };
    expect(state.posts.map((p) => p.idempotencyKey)).toEqual([p2!.idempotencyKey]);
    second.kill();
  }, 60_000);

  it('druga instancja workera odmawia startu', async () => {
    const dataDir = tmpDataDir();
    const first = startWorker(dataDir);
    await waitFor(async () => fs.existsSync(path.join(dataDir, 'worker.pid')));
    const second = startWorker(dataDir);
    let stderr = '';
    second.stderr!.on('data', (d) => (stderr += String(d)));
    const code = await new Promise<number | null>((r) => second.once('exit', r));
    expect(code).toBe(1);
    expect(stderr).toMatch(/już działa/);
    first.kill();
  }, 30_000);
});
