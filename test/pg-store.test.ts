import crypto from 'node:crypto';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { PostgresStore } from '../src/core/db/pg-store.js';
import { DbImageRepo, DbPause, DbSecret, DbUploadRegistry } from '../src/core/db/server-backends.js';
import { PlanAlreadyCommittedError, PlanExpiredError, newId, type Plan } from '../src/core/index.js';
import { plannedPost, toNewPost } from './helpers.js';

const pgUrl = inject('pgUrl');
const d = pgUrl ? describe : describe.skip;
const NOW = '2026-10-01T10:00:00.000Z';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const opened: PostgresStore[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function open(schema = `t_${crypto.randomBytes(5).toString('hex')}`) {
  const s = await PostgresStore.connect(pgUrl!, { schema });
  opened.push(s);
  return { s, schema };
}

function plan(posts = [plannedPost(1, '2026-10-02T06:00:00.000Z'), plannedPost(2, '2026-10-03T06:00:00.000Z')]): Plan {
  return { id: newId('plan'), createdAt: NOW, expiresAt: '2026-10-01T10:30:00.000Z', posts, committedSeriesId: null, committedAt: null };
}

d('PostgresStore: kolejka (ten sam kontrakt co SQLite)', () => {
  it('zatwierdza plan raz; wygasły plan odrzucony', async () => {
    const { s } = await open();
    const p = plan();
    await s.savePlan(p);
    const { posts } = await s.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid, 'live')), newId('ser'));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.mode).toBe('live');
    await expect(s.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'))).rejects.toBeInstanceOf(PlanAlreadyCommittedError);
    const q = plan();
    await s.savePlan(q);
    await expect(s.commitPlan(q.id, '2026-10-01T10:30:00.000Z', (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'))).rejects.toBeInstanceOf(PlanExpiredError);
    expect(await s.listPosts()).toHaveLength(2);
  });

  it('blokada wiersza: z dwóch połączeń tylko jedno przejmuje post; wersja chroni przed nieaktualną zmianą', async () => {
    const { s: a, schema } = await open();
    const { s: b } = await open(schema);
    const p = plan([plannedPost(1, '2026-10-01T09:59:00.000Z')]);
    await a.savePlan(p);
    const { posts } = await a.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'));
    const id = posts[0]!.id;
    const results = await Promise.all([
      a.transitionPost(id, ['scheduled'], { status: 'publishing' }, NOW),
      b.transitionPost(id, ['scheduled'], { status: 'publishing' }, NOW),
      a.transitionPost(id, ['scheduled'], { status: 'publishing' }, NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const cur = (await b.getPost(id))!;
    expect(await b.transitionPost(id, ['publishing'], { text: 'x' }, NOW, cur.version - 1)).toBeNull();
    expect(await b.transitionPost(id, ['publishing'], { lastError: { code: 'c', message: 'm', at: NOW } }, NOW, cur.version)).not.toBeNull();
    expect((await a.getPost(id))!.lastError).toEqual({ code: 'c', message: 'm', at: NOW });
  });

  it('filtry, okno kolizji, duplikaty, zdarzenia, audyt, metadane logowania per tryb', async () => {
    const { s } = await open();
    const p = plan([plannedPost(1, '2026-10-01T09:50:00.000Z', 'Ten sam'), plannedPost(2, '2026-10-02T06:00:30.000Z')]);
    await s.savePlan(p);
    const { posts } = await s.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'));
    expect((await s.findDuePosts(NOW)).map((x) => x.id)).toEqual([posts[0]!.id]);
    expect(await s.listPosts({ status: ['scheduled', 'failed'], fromUtc: '2026-10-02T00:00:00.000Z' })).toHaveLength(1);
    expect(await s.findInWindow('2026-10-02T06:00:00.000Z', '2026-10-02T06:05:00.000Z')).toHaveLength(1);
    expect(await s.findByTextHash(posts[0]!.textHash)).toHaveLength(1);
    await s.addEvent(posts[0]!.id, 'x', { a: 1 }, NOW);
    expect((await s.getEvents(posts[0]!.id)).map((e) => e.type)).toEqual(['created', 'x']);
    await s.appendAudit({ at: NOW, actor: 'mcp', action: 'a', target: null, result: 'ok', detail: { k: 'v' } });
    expect((await s.listAudit())[0]).toMatchObject({ action: 'a', detail: { k: 'v' } });
    const meta = { personUrn: 'urn:li:person:x', profileName: 'X', profileUrl: null, expiresAt: null, scopes: ['a'], canComment: 'no' as const, updatedAt: NOW };
    await s.setAuthMeta('live', meta);
    expect(await s.getAuthMeta('mock')).toBeNull();
    expect((await s.getAuthMeta('live'))!.canComment).toBe('no');
    expect(await s.deleteExpiredPlans('2099-01-01T00:00:00.000Z')).toBe(0); // zatwierdzone plany zostają
  });

  it('migracje są idempotentne (ponowne połączenie z tym samym schematem)', async () => {
    const { schema } = await open();
    const { s } = await open(schema);
    expect(await s.listPosts()).toEqual([]);
  });
});

d('PostgresStore: dane serwera', () => {
  it('obrazy w bazie (bytea) z weryfikacją sumy kontrolnej', async () => {
    const { s } = await open();
    const repo = new DbImageRepo(s);
    const img = await repo.put(PNG, 'a.png', 10_000_000, 'opis');
    expect(img.file).toBe(`db:${img.sha256}`);
    expect((await repo.read(img))!.equals(PNG)).toBe(true);
    expect(await repo.read({ ...img, sha256: 'f'.repeat(64) })).toBeNull();
    await repo.put(PNG, 'b.png', 10_000_000, ''); // ta sama treść - bez duplikatu
  });

  it('bilet przesyłania: pending -> done tylko raz i tylko przed wygaśnięciem', async () => {
    const { s } = await open();
    const reg = new DbUploadRegistry(s, 'https://example.test');
    const now = new Date('2026-10-01T10:00:00.000Z');
    const t = await reg.create(now);
    expect(t.uploadUrl).toMatch(/^https:\/\/example\.test\/upload\/[A-Za-z0-9_-]{30,}$/);
    expect((await reg.get(t.imageId, now)).status).toBe('pending');
    const img = await new DbImageRepo(s).put(PNG, 'a.png', 10_000_000, '');
    expect(await s.completeUpload(t.imageId, img.sha256, 'a.png', '2026-10-01T10:01:00.000Z')).toBe(true);
    expect(await s.completeUpload(t.imageId, img.sha256, 'a.png', '2026-10-01T10:02:00.000Z')).toBe(false);
    const st = await reg.get(t.imageId, now);
    expect(st).toMatchObject({ status: 'done', image: { sha256: img.sha256, originalName: 'a.png', width: 1 } });
    const late = await reg.create(now);
    expect(await s.completeUpload(late.imageId, img.sha256, 'x', '2026-10-01T10:20:00.000Z')).toBe(false);
    expect((await reg.get(late.imageId, new Date('2026-10-01T10:20:00.000Z'))).status).toBe('expired');
  });

  it('sekrety, bezpiecznik, jednorazowe kody i rotacja tokenów odświeżania', async () => {
    const { s } = await open();
    const sec = new DbSecret(s, 'linkedin_token');
    expect(await sec.read()).toBeNull();
    await sec.write('enc');
    expect(await sec.read()).toBe('enc');
    expect(await sec.clear()).toBe(true);

    const pause = new DbPause(s);
    expect((await pause.read()).paused).toBe(false);
    await pause.set('urlop');
    expect(await pause.read()).toMatchObject({ paused: true, reason: 'urlop' });
    await pause.clear();
    expect((await pause.read()).paused).toBe(false);

    await s.createCode({ codeHash: 'h1', clientId: 'c', redirectUri: 'r', codeChallenge: 'x', scope: null, personUrn: 'p', expiresAt: '2026-10-01T10:05:00.000Z' });
    expect(await s.takeCode('h1', NOW)).not.toBeNull();
    expect(await s.takeCode('h1', NOW)).toBeNull(); // jednorazowy

    const base = { kind: 'refresh' as const, clientId: 'c', familyId: 'f1', scope: null, personUrn: 'p', expiresAt: '2026-12-01T00:00:00.000Z', revokedAt: null, createdAt: NOW };
    await s.createToken({ ...base, tokenHash: 'r1' });
    const [x, y] = await Promise.all([s.consumeRefreshToken('r1', NOW), s.consumeRefreshToken('r1', NOW)]);
    expect([x, y].filter(Boolean)).toHaveLength(1); // równoległa rotacja: tylko jedna wygrywa
    await s.createToken({ ...base, tokenHash: 'a1', kind: 'access' });
    expect(await s.revokeFamily('f1', NOW)).toBe(1);
    expect((await s.getToken('a1'))!.revokedAt).toBe(NOW);
  });
});
