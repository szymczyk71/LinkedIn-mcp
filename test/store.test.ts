import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  PlanAlreadyCommittedError,
  PlanExpiredError,
  SqliteStore,
  newId,
  redact,
  type Plan,
} from '../src/core/index.js';
import { plannedPost, tmpDataDir, toNewPost } from './helpers.js';

const NOW = '2026-10-01T10:00:00.000Z';
const stores: SqliteStore[] = [];
function open(file = ':memory:') {
  const s = new SqliteStore(file);
  stores.push(s);
  return s;
}
afterEach(async () => {
  while (stores.length) await stores.pop()!.close();
});

function plan(posts = [plannedPost(1, '2026-10-02T06:00:00.000Z'), plannedPost(2, '2026-10-03T06:00:00.000Z')]): Plan {
  return { id: newId('plan'), createdAt: NOW, expiresAt: '2026-10-01T10:30:00.000Z', posts, committedSeriesId: null, committedAt: null };
}

describe('SqliteStore', () => {
  it('zapisuje plan i zatwierdza go dokładnie raz', async () => {
    const s = open();
    const p = plan();
    await s.savePlan(p);
    const { series, posts } = await s.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'));
    expect(posts).toHaveLength(2);
    expect(posts.every((x) => x.status === 'scheduled' && x.seriesId === series.id)).toBe(true);

    await expect(s.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'))).rejects.toBeInstanceOf(
      PlanAlreadyCommittedError,
    );
    expect(await s.listPosts()).toHaveLength(2);
    expect((await s.getPlan(p.id))!.committedSeriesId).toBe(series.id);
  });

  it('odrzuca zatwierdzenie wygasłego planu', async () => {
    const s = open();
    const p = plan();
    await s.savePlan(p);
    await expect(
      s.commitPlan(p.id, '2026-10-01T10:30:00.000Z', (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser')),
    ).rejects.toBeInstanceOf(PlanExpiredError);
    expect(await s.listPosts()).toHaveLength(0);
  });

  it('transitionPost działa jak blokada wiersza: tylko jeden z dwóch procesów przejmuje post', async () => {
    const file = path.join(tmpDataDir(), 'db.sqlite');
    const a = open(file);
    const b = open(file); // drugie połączenie = drugi proces
    const p = plan([plannedPost(1, '2026-10-01T09:59:00.000Z')]);
    await a.savePlan(p);
    const { posts } = await a.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'));
    const id = posts[0]!.id;

    const [ra, rb] = await Promise.all([
      a.transitionPost(id, ['scheduled'], { status: 'publishing' }, NOW),
      b.transitionPost(id, ['scheduled'], { status: 'publishing' }, NOW),
    ]);
    expect([ra, rb].filter(Boolean)).toHaveLength(1);
    expect((await b.getPost(id))!.status).toBe('publishing');
    expect((await b.getPost(id))!.version).toBe(2);
  });

  it('transitionPost z wersją odrzuca nieaktualną zmianę', async () => {
    const s = open();
    const p = plan([plannedPost(1, '2026-10-02T06:00:00.000Z')]);
    await s.savePlan(p);
    const { posts } = await s.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'));
    const post = posts[0]!;
    expect(await s.transitionPost(post.id, ['scheduled'], { text: 'A' }, NOW, post.version)).not.toBeNull();
    expect(await s.transitionPost(post.id, ['scheduled'], { text: 'B' }, NOW, post.version)).toBeNull();
    expect((await s.getPost(post.id))!.text).toBe('A');
  });

  it('zapisuje i odczytuje pola JSON oraz filtruje kolejkę', async () => {
    const s = open();
    const p = plan();
    await s.savePlan(p);
    const { posts } = await s.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'));
    await s.transitionPost(posts[0]!.id, ['scheduled'], { status: 'failed', lastError: { code: 'x', message: 'm', ambiguous: true, at: NOW } }, NOW);
    const failed = await s.listPosts({ status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.lastError).toEqual({ code: 'x', message: 'm', ambiguous: true, at: NOW });
    expect(await s.listPosts({ fromUtc: '2026-10-03T00:00:00.000Z' })).toHaveLength(1);
    expect(await s.listPosts({ toUtc: '2026-10-02T23:59:59.000Z' })).toHaveLength(1);
    expect(await s.listPosts({ status: ['failed', 'scheduled'] })).toHaveLength(2);
  });

  it('findDuePosts, findInWindow i findByTextHash', async () => {
    const s = open();
    const p = plan([plannedPost(1, '2026-10-01T09:50:00.000Z', 'Ten sam tekst'), plannedPost(2, '2026-10-02T06:00:30.000Z')]);
    await s.savePlan(p);
    const { posts } = await s.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'));
    expect((await s.findDuePosts(NOW)).map((x) => x.id)).toEqual([posts[0]!.id]);
    expect(await s.findInWindow('2026-10-02T06:00:00.000Z', '2026-10-02T06:05:00.000Z')).toHaveLength(1);
    expect(await s.findInWindow('2026-10-02T06:00:30.000Z', '2026-10-02T06:05:00.000Z')).toHaveLength(0);
    expect(await s.findInWindow('2026-10-02T06:00:00.000Z', '2026-10-02T06:05:00.000Z', posts[1]!.id)).toHaveLength(0);
    expect(await s.findByTextHash(posts[0]!.textHash)).toHaveLength(1);
    await s.transitionPost(posts[0]!.id, ['scheduled'], { status: 'canceled' }, NOW);
    expect(await s.findByTextHash(posts[0]!.textHash)).toHaveLength(0);
  });

  it('historia zdarzeń posta', async () => {
    const s = open();
    const p = plan([plannedPost(1, '2026-10-02T06:00:00.000Z')]);
    await s.savePlan(p);
    const { posts } = await s.commitPlan(p.id, NOW, (pl, sid) => pl.posts.map((x) => toNewPost(x, sid)), newId('ser'));
    await s.addEvent(posts[0]!.id, 'updated', { fields: ['text'] }, NOW);
    const ev = await s.getEvents(posts[0]!.id);
    expect(ev.map((e) => e.type)).toEqual(['created', 'updated']);
  });

  it('metadane logowania', async () => {
    const s = open();
    expect(await s.getAuthMeta()).toBeNull();
    const meta = {
      personUrn: 'urn:li:person:X',
      profileName: 'Szymon',
      profileUrl: null,
      expiresAt: '2026-12-01T00:00:00.000Z',
      scopes: ['w_member_social'],
      canComment: 'unknown' as const,
      updatedAt: NOW,
    };
    await s.setAuthMeta(meta);
    await s.setAuthMeta({ ...meta, canComment: 'yes' });
    expect((await s.getAuthMeta())!.canComment).toBe('yes');
  });

  it('migracje są idempotentne przy ponownym otwarciu pliku', async () => {
    const file = path.join(tmpDataDir(), 'db.sqlite');
    await open(file).close();
    stores.pop();
    const again = open(file);
    expect(await again.listPosts()).toEqual([]);
  });
});

describe('dziennik audytu', () => {
  it('zapisuje do bazy i JSONL bez sekretów', async () => {
    const s = open();
    const file = path.join(tmpDataDir(), 'audit.jsonl');
    const audit = new AuditLog(s, file);
    await audit.record('mcp', 'linkedin_commit_series', 'ok', 'plan_1', {
      access_token: 'AQX-secret',
      nested: { client_secret: 'zzz', header: 'Bearer abc.def.ghi' },
      note: 'zwykły tekst',
    });
    const [entry] = await s.listAudit();
    const raw = fs.readFileSync(file, 'utf8');
    for (const text of [JSON.stringify(entry), raw]) {
      expect(text).not.toContain('AQX-secret');
      expect(text).not.toContain('zzz');
      expect(text).not.toContain('abc.def.ghi');
      expect(text).toContain('zwykły tekst');
    }
  });

  it('redact maskuje długie nieprzezroczyste ciągi', () => {
    const token = 'A'.repeat(80);
    expect(redact({ msg: `token=${token}` }).msg).not.toContain(token);
  });
});
