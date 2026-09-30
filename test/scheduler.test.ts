import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeClock,
  MockLinkedIn,
  Scheduler,
  SqliteStore,
  createCore,
  newId,
  parseLocalDateTime,
  setPause,
  clearPause,
  type CoreContext,
  type MockScenario,
  type PlannedPost,
  type Post,
} from '../src/core/index.js';
import { plannedPost, testConfig, tmpDataDir, toNewPost } from './helpers.js';

const T0 = '2026-11-06T07:00:00.000Z'; // 08:00 w Warszawie
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup(opts: { dbFile?: string; scenario?: MockScenario; clock?: FakeClock; mock?: MockLinkedIn; dataDir?: string } = {}) {
  const config = testConfig(opts.dataDir ? { LINKEDIN_MCP_DATA_DIR: opts.dataDir } : {});
  const clock = opts.clock ?? new FakeClock(T0);
  const mock = opts.mock ?? new MockLinkedIn({ scenario: opts.scenario });
  const store = new SqliteStore(opts.dbFile ?? ':memory:');
  const ctx: CoreContext = createCore(config, { store, linkedin: mock, clock, auditFile: null });
  cleanups.push(() => store.close());
  return { ctx, clock, mock, store, scheduler: new Scheduler(ctx), config };
}

async function seed(ctx: CoreContext, posts: PlannedPost[]): Promise<Post[]> {
  const now = ctx.clock.now().toISOString();
  const planId = newId('plan');
  await ctx.store.savePlan({
    id: planId,
    createdAt: now,
    expiresAt: new Date(ctx.clock.now().getTime() + 30 * 60_000).toISOString(),
    posts,
    committedSeriesId: null,
    committedAt: null,
  });
  return (await ctx.store.commitPlan(planId, now, (p, sid) => p.posts.map((x) => toNewPost(x, sid)), newId('ser'))).posts;
}

const get = async (ctx: CoreContext, id: string) => (await ctx.store.getPost(id))!;

describe('harmonogram: publikacja i komentarz', () => {
  it('publikuje o czasie, potem dodaje komentarz po opóźnieniu i ustawia can_comment=yes', async () => {
    const { ctx, clock, mock, scheduler, store } = setup();
    const [p] = await seed(ctx, [plannedPost(1, T0)]);
    const r = await scheduler.tick();
    expect(r.published).toEqual([p!.id]);
    const after = await get(ctx, p!.id);
    expect(after.status).toBe('published');
    expect(after.postUrl).toMatch(/^https:\/\/www\.linkedin\.com\/feed\/update\//);
    expect(after.commentDueUtc).toBe('2026-11-06T07:10:00.000Z');
    expect(after.commentStatus).toBe('waiting');
    expect((await store.getAuthMeta())?.canComment ?? 'unknown').toBe('unknown');

    clock.advanceMin(5);
    expect((await scheduler.tick()).commentsDone).toEqual([]);
    clock.advanceMin(5);
    expect((await scheduler.tick()).commentsDone).toEqual([p!.id]);
    expect((await get(ctx, p!.id)).commentStatus).toBe('done');
    expect(mock.posts[0]!.comments[0]!.text).toBe('Komentarz');
    expect((await store.getAuthMeta())!.canComment).toBe('yes');
  });

  it('nie publikuje przed terminem', async () => {
    const { ctx, scheduler, mock } = setup();
    await seed(ctx, [plannedPost(1, '2026-11-06T07:05:00.000Z')]);
    expect((await scheduler.tick()).published).toEqual([]);
    expect(mock.calls.publishPost).toBe(0);
  });

  it('post bez komentarza: comment_status = none, brak próby komentarza', async () => {
    const { ctx, clock, scheduler, mock } = setup();
    const [p] = await seed(ctx, [{ ...plannedPost(1, T0), commentText: '' }]);
    await scheduler.tick();
    expect((await get(ctx, p!.id)).commentStatus).toBe('none');
    clock.advanceMin(30);
    await scheduler.tick();
    expect(mock.calls.addComment).toBe(0);
  });

  it('post zaplanowany między przebiegami wychodzi w najbliższym przebiegu', async () => {
    const { ctx, clock, scheduler } = setup();
    const [p] = await seed(ctx, [plannedPost(1, '2026-11-06T07:02:00.000Z')]);
    expect((await scheduler.tick()).published).toEqual([]); // 07:00
    clock.advanceMin(5); // 07:05
    expect((await scheduler.tick()).published).toEqual([p!.id]);
  });
});

describe('polityka "missed" (komputer był wyłączony)', () => {
  it('spóźnienie < 60 min: publikuje', async () => {
    const { ctx, clock, scheduler } = setup();
    const [p] = await seed(ctx, [plannedPost(1, T0)]);
    clock.advanceMin(59);
    expect((await scheduler.tick()).published).toEqual([p!.id]);
  });

  it('spóźnienie >= 60 min: status missed, bez publikacji, także w kolejnych przebiegach', async () => {
    const { ctx, clock, scheduler, mock } = setup();
    const [a, b] = await seed(ctx, [plannedPost(1, T0), plannedPost(2, '2026-11-06T07:30:00.000Z')]);
    clock.set('2026-11-06T08:00:00.000Z'); // a: 60 min, b: 30 min
    const r = await scheduler.tick();
    expect(r.missed).toEqual([a!.id]);
    expect(r.published).toEqual([b!.id]);
    expect((await get(ctx, a!.id)).status).toBe('missed');
    clock.advanceMin(5);
    await scheduler.tick();
    expect(mock.calls.publishPost).toBe(1);
    expect((await ctx.store.getEvents(a!.id)).map((e) => e.type)).toContain('missed');
  });

  it('próg jest konfigurowalny (MISSED_GRACE_MIN)', async () => {
    const config = testConfig({ MISSED_GRACE_MIN: '15' });
    const clock = new FakeClock(T0);
    const store = new SqliteStore(':memory:');
    cleanups.push(() => store.close());
    const ctx = createCore(config, { store, linkedin: new MockLinkedIn(), clock, auditFile: null });
    const [p] = await seed(ctx, [plannedPost(1, T0)]);
    clock.advanceMin(20);
    expect((await new Scheduler(ctx).tick()).missed).toEqual([p!.id]);
  });

  it('post missed po nadaniu nowego terminu wraca do scheduled i zostaje opublikowany', async () => {
    const { ctx, clock, scheduler } = setup();
    const [p] = await seed(ctx, [plannedPost(1, T0)]);
    clock.advanceMin(24 * 60);
    await scheduler.tick();
    const missed = await get(ctx, p!.id);
    expect(missed.status).toBe('missed');
    const newAt = new Date(clock.now().getTime() + 10 * 60_000).toISOString();
    await ctx.store.transitionPost(p!.id, ['missed'], { status: 'scheduled', publishAtUtc: newAt }, clock.now().toISOString(), missed.version);
    clock.advanceMin(10);
    expect((await scheduler.tick()).published).toEqual([p!.id]);
  });

  it('komentarz spóźniony ponad próg jest pomijany', async () => {
    const { ctx, clock, scheduler, mock } = setup();
    const [p] = await seed(ctx, [plannedPost(1, T0)]);
    await scheduler.tick();
    clock.advanceMin(10 + 60);
    expect((await scheduler.tick()).commentsSkipped).toEqual([p!.id]);
    expect(mock.calls.addComment).toBe(0);
    expect((await get(ctx, p!.id)).commentError?.code).toBe('comment_missed');
  });
});

describe('bezpiecznik PAUSE', () => {
  it('przy pauzie nic nie jest publikowane ani komentowane; po resume publikacja rusza', async () => {
    const { ctx, clock, scheduler, mock, config } = setup();
    const [a] = await seed(ctx, [plannedPost(1, T0)]);
    setPause(config.paths.pauseFlagFile, 'test');
    const r = await scheduler.tick();
    expect(r.paused).toBe(true);
    expect(mock.calls.publishPost).toBe(0);
    clearPause(config.paths.pauseFlagFile);
    clock.advanceMin(5);
    expect((await scheduler.tick()).published).toEqual([a!.id]);

    setPause(config.paths.pauseFlagFile, null);
    clock.advanceMin(10);
    await scheduler.tick();
    expect(mock.calls.addComment).toBe(0);
    clearPause(config.paths.pauseFlagFile);
    await scheduler.tick();
    expect(mock.calls.addComment).toBe(1);
  });

  it('pauza nie wstrzymuje polityki missed', async () => {
    const { ctx, clock, scheduler, config } = setup();
    const [a] = await seed(ctx, [plannedPost(1, T0)]);
    setPause(config.paths.pauseFlagFile, null);
    clock.advanceMin(90);
    expect((await scheduler.tick()).missed).toEqual([a!.id]);
  });
});

describe('idempotencja i blokada wiersza', () => {
  it('dwa przebiegi pod rząd publikują post tylko raz', async () => {
    const { ctx, scheduler, mock } = setup();
    await seed(ctx, [plannedPost(1, T0)]);
    await scheduler.tick();
    await scheduler.tick();
    expect(mock.calls.publishPost).toBe(1);
  });

  it('dwa procesy (osobne połączenia z bazą) w tym samym momencie: jedna publikacja', async () => {
    const dir = tmpDataDir();
    const dbFile = path.join(dir, 'shared.db');
    const mock = new MockLinkedIn({ scenario: { delayMs: 50 } });
    const clock = new FakeClock(T0);
    const a = setup({ dbFile, mock, clock, dataDir: dir });
    const b = setup({ dbFile, mock, clock, dataDir: dir });
    const posts = await seed(a.ctx, [plannedPost(1, T0), plannedPost(2, T0)]);
    const [ra, rb] = await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
    expect([...ra.published, ...rb.published].sort()).toEqual(posts.map((p) => p.id).sort());
    expect(mock.posts).toHaveLength(2);
    expect(new Set(mock.posts.map((p) => p.idempotencyKey)).size).toBe(2);
  });
});

describe('restart workera w trakcie pracy', () => {
  it('post przerwany w stanie publishing -> failed (niejednoznaczne), bez ponownej publikacji', async () => {
    const dir = tmpDataDir();
    const dbFile = path.join(dir, 'shared.db');
    const clock = new FakeClock(T0);
    const mock = new MockLinkedIn({ scenario: { delayMs: 300 } });
    const first = setup({ dbFile, mock, clock, dataDir: dir });
    const [p] = await seed(first.ctx, [plannedPost(1, T0)]);

    const inFlight = first.scheduler.tick(); // "stary" proces publikuje...
    await new Promise((r) => setTimeout(r, 50));
    expect((await get(first.ctx, p!.id)).status).toBe('publishing');

    // ...i "ginie"; nowy proces startuje i porządkuje stan.
    const second = setup({ dbFile, mock, clock, dataDir: dir });
    const rec = await second.scheduler.recoverOnStartup();
    expect(rec.interruptedPosts).toEqual([p!.id]);
    const failed = await get(second.ctx, p!.id);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toMatchObject({ code: 'publish_interrupted', ambiguous: true });
    expect(failed.commentStatus).toBe('skipped');

    clock.advanceMin(5);
    await second.scheduler.tick();
    await inFlight;
    expect(mock.calls.publishPost).toBe(1);
  });

  it('komentarz przerwany w trakcie wysyłania -> failed (niejednoznaczne), bez ponawiania', async () => {
    const { ctx, clock, scheduler, mock } = setup();
    const [p] = await seed(ctx, [plannedPost(1, T0)]);
    await scheduler.tick();
    const pub = await get(ctx, p!.id);
    // Symulacja: proces zdążył oznaczyć komentarz jako rozpoczęty i zginął.
    await ctx.store.transitionPost(p!.id, ['published'], { commentClaimedAt: clock.now().toISOString() }, clock.now().toISOString(), pub.version);
    const rec = await new Scheduler(ctx).recoverOnStartup();
    expect(rec.interruptedComments).toEqual([p!.id]);
    clock.advanceMin(15);
    await scheduler.tick();
    expect(mock.calls.addComment).toBe(0);
    expect((await get(ctx, p!.id)).commentStatus).toBe('failed');
  });
});

describe('scenariusze błędów atrapy', () => {
  const cases: { mode: NonNullable<MockScenario['publish']>; code: string; ambiguous: boolean; created: number }[] = [
    { mode: 'reject', code: 'linkedin_rejected', ambiguous: false, created: 0 },
    { mode: 'timeout', code: 'linkedin_timeout', ambiguous: true, created: 1 },
    { mode: 'ambiguous', code: 'linkedin_ambiguous', ambiguous: true, created: 1 },
    { mode: 'unauthorized', code: 'linkedin_unauthorized', ambiguous: false, created: 0 },
    { mode: 'rate_limited', code: 'linkedin_rate_limited', ambiguous: false, created: 0 },
    { mode: 'network', code: 'linkedin_network', ambiguous: false, created: 0 },
  ];
  for (const c of cases) {
    it(`publikacja: ${String(c.mode)} -> failed, bez automatycznego ponawiania`, async () => {
      const { ctx, clock, scheduler, mock } = setup({ scenario: { publish: c.mode } });
      const [p] = await seed(ctx, [plannedPost(1, T0)]);
      expect((await scheduler.tick()).failed).toEqual([p!.id]);
      const post = await get(ctx, p!.id);
      expect(post.status).toBe('failed');
      expect(post.lastError).toMatchObject({ code: c.code, ambiguous: c.ambiguous });
      if (c.ambiguous) expect(post.lastError!.message).toMatch(/nie ponawia/);
      expect(post.commentStatus).toBe('skipped');
      expect(mock.posts).toHaveLength(c.created);
      mock.setScenario({});
      for (let i = 0; i < 3; i++) {
        clock.advanceMin(5);
        await scheduler.tick();
      }
      expect(mock.calls.publishPost).toBe(1);
    });
  }

  it('brak uprawnień do komentarza -> comment skipped, can_comment=no', async () => {
    const { ctx, clock, scheduler, store } = setup({ scenario: { comment: 'forbidden' } });
    const [p] = await seed(ctx, [plannedPost(1, T0)]);
    await scheduler.tick();
    clock.advanceMin(10);
    expect((await scheduler.tick()).commentsSkipped).toEqual([p!.id]);
    const post = await get(ctx, p!.id);
    expect(post.commentStatus).toBe('skipped');
    expect(post.commentError?.code).toBe('linkedin_forbidden');
    expect((await store.getAuthMeta())!.canComment).toBe('no');
  });

  for (const mode of ['timeout', 'ambiguous', 'reject', 'unauthorized'] as const) {
    it(`komentarz: ${mode} -> failed, bez ponawiania`, async () => {
      const { ctx, clock, scheduler, mock } = setup({ scenario: { comment: mode } });
      const [p] = await seed(ctx, [plannedPost(1, T0)]);
      await scheduler.tick();
      clock.advanceMin(10);
      expect((await scheduler.tick()).commentsFailed).toEqual([p!.id]);
      mock.setScenario({});
      clock.advanceMin(5);
      await scheduler.tick();
      expect(mock.calls.addComment).toBe(1);
      expect((await get(ctx, p!.id)).commentError?.ambiguous).toBe(mode === 'timeout' || mode === 'ambiguous');
    });
  }
});

describe('tryb "later" dla linku', () => {
  const later = (ifNoLink: 'post_without_link' | 'skip', noLink: string | null): PlannedPost => ({
    ...plannedPost(1, T0),
    commentText: 'Więcej tutaj: [LINK]',
    linkMode: 'later',
    ifNoLink,
    commentTextNoLink: noLink,
  });

  it('link podany przed terminem komentarza trafia w miejsce [LINK]', async () => {
    const { ctx, clock, scheduler, mock } = setup();
    const [p] = await seed(ctx, [later('post_without_link', 'Więcej wkrótce')]);
    expect(p!.commentStatus).toBe('waiting_link');
    await scheduler.tick();
    const pub = await get(ctx, p!.id);
    await ctx.store.transitionPost(p!.id, ['published'], { commentUrl: 'https://example.com/a?b=1', commentStatus: 'waiting' }, clock.now().toISOString(), pub.version);
    clock.advanceMin(10);
    await scheduler.tick();
    expect(mock.posts[0]!.comments[0]!.text).toBe('Więcej tutaj: https://example.com/a?b=1');
  });

  it('brak linku + post_without_link: dodaje zatwierdzoną wersję bez linku', async () => {
    const { ctx, clock, scheduler, mock } = setup();
    const [p] = await seed(ctx, [later('post_without_link', 'Więcej wkrótce')]);
    await scheduler.tick();
    clock.advanceMin(10);
    expect((await scheduler.tick()).commentsDone).toEqual([p!.id]);
    expect(mock.posts[0]!.comments[0]!.text).toBe('Więcej wkrótce');
    expect((await ctx.store.getEvents(p!.id)).find((e) => e.type === 'comment_done')!.detail).toEqual({ usedFallback: true });
  });

  it('brak linku + skip: komentarz pominięty', async () => {
    const { ctx, clock, scheduler, mock } = setup();
    const [p] = await seed(ctx, [later('skip', null)]);
    await scheduler.tick();
    clock.advanceMin(10);
    expect((await scheduler.tick()).commentsSkipped).toEqual([p!.id]);
    expect(mock.calls.addComment).toBe(0);
  });
});

describe('zmiana czasu w harmonogramie', () => {
  it('jesień: posty przed i po zmianie wychodzą o właściwej godzinie UTC', async () => {
    const clock = new FakeClock('2026-10-24T06:00:00.000Z');
    const { ctx, scheduler } = setup({ clock });
    const before = parseLocalDateTime('2026-10-24T09:00:00', 'Europe/Warsaw').utc; // 07:00Z
    const doubled = parseLocalDateTime('2026-10-25T02:30:00', 'Europe/Warsaw').utc; // 00:30Z (pierwsze wystąpienie)
    const after = parseLocalDateTime('2026-10-25T09:00:00', 'Europe/Warsaw').utc; // 08:00Z
    const [a, b, c] = await seed(ctx, [plannedPost(1, before), plannedPost(2, doubled), plannedPost(3, after)]);

    clock.set('2026-10-24T07:00:00.000Z');
    expect((await scheduler.tick()).published).toEqual([a!.id]);
    clock.set('2026-10-25T00:30:00.000Z');
    expect((await scheduler.tick()).published).toEqual([b!.id]);
    clock.set('2026-10-25T07:55:00.000Z'); // 08:55 czasu zimowego - jeszcze nie
    expect((await scheduler.tick()).published).toEqual([]);
    clock.set('2026-10-25T08:00:00.000Z');
    expect((await scheduler.tick()).published).toEqual([c!.id]);
  });

  it('wiosna: post o 03:00 w dniu zmiany wychodzi o 01:00 UTC', async () => {
    const clock = new FakeClock('2027-03-28T00:00:00.000Z');
    const { ctx, scheduler } = setup({ clock });
    const [p] = await seed(ctx, [plannedPost(1, parseLocalDateTime('2027-03-28T03:00:00', 'Europe/Warsaw').utc)]);
    clock.set('2027-03-28T00:55:00.000Z');
    expect((await scheduler.tick()).published).toEqual([]);
    clock.set('2027-03-28T01:00:00.000Z');
    expect((await scheduler.tick()).published).toEqual([p!.id]);
  });
});

describe('wygasłe plany', () => {
  it('przebieg usuwa niezatwierdzone, wygasłe plany', async () => {
    const { ctx, clock, scheduler } = setup();
    const id = newId('plan');
    await ctx.store.savePlan({ id, createdAt: T0, expiresAt: '2026-11-06T07:30:00.000Z', posts: [], committedSeriesId: null, committedAt: null });
    clock.advanceMin(31);
    expect((await scheduler.tick()).expiredPlansDeleted).toBe(1);
    expect(await ctx.store.getPlan(id)).toBeNull();
  });
});
