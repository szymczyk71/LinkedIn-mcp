import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeClock,
  LinkedInService,
  MockLinkedIn,
  Scheduler,
  SqliteStore,
  ToolError,
  createCore,
  setPause,
  type CoreContext,
  type PreviewSeriesArgs,
} from '../src/core/index.js';
import { testConfig } from './helpers.js';

const T0 = '2026-11-06T07:00:00.000Z'; // 08:00 w Warszawie (czas zimowy)
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup(env: Record<string, string> = {}, start = T0) {
  const config = testConfig(env);
  const clock = new FakeClock(start);
  const mock = new MockLinkedIn({ expiresAt: '2026-12-31T00:00:00.000Z' });
  const store = new SqliteStore(':memory:');
  cleanups.push(() => store.close());
  const ctx: CoreContext = createCore(config, { store, linkedin: mock, clock, auditFile: null });
  return { ctx, clock, mock, store, svc: new LinkedInService(ctx), scheduler: new Scheduler(ctx), config };
}

let n = 0;
const post = (publish_at: string, extra: Partial<PreviewSeriesArgs['posts'][number]> = {}) => ({
  text: `Post numer ${++n} o architekturze #Azure & „jakości” 🙂`,
  publish_at,
  comment_text: 'Komentarz pod postem',
  ...extra,
});

async function expectToolError(p: Promise<unknown>, code: string): Promise<ToolError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, `oczekiwano błędu ${code}`).toBeInstanceOf(ToolError);
  expect((e as ToolError).code).toBe(code);
  return e as ToolError;
}

async function commitOne(svc: LinkedInService, publishAt = '2026-11-06T09:00:00', extra = {}) {
  const pv = await svc.previewSeries({ posts: [post(publishAt, extra)] });
  expect(pv.plan_id, JSON.stringify(pv.posts[0])).toBeTruthy();
  const c = await svc.commitSeries({ plan_id: pv.plan_id });
  return c.posts[0]!;
}

describe('linkedin_preview_series: walidacje z kontraktu', () => {
  it('poprawna seria: plan_id, czasy lokalne i UTC, liczba znaków, nic nie trafia do kolejki', async () => {
    const { svc, store } = setup();
    const r = await svc.previewSeries({ posts: [post('2026-11-06T09:00:00'), post('2026-11-07T09:00:00', { comment_text: '' })] });
    expect(r.plan_id).toMatch(/^plan_/);
    expect(r.expires_in_min).toBe(30);
    expect(r.posts[0]).toMatchObject({
      number: 1,
      publish_at_local: '2026-11-06T09:00:00+01:00',
      publish_at_utc: '2026-11-06T08:00:00.000Z',
      errors: [],
      warnings: [],
    });
    expect(r.posts[0]!.chars).toBeGreaterThan(10);
    expect(r.posts[1]!.comment).toBeNull();
    expect(r.summary).toMatchObject({ posts: 2, with_comment: 1, errors: 0, ready_to_commit: true });
    expect(await store.listPosts()).toHaveLength(0);
  });

  it('termin co najmniej 5 minut w przyszłości', async () => {
    const { svc } = setup();
    const r = await svc.previewSeries({ posts: [post('2026-11-06T08:04:00'), post('2026-11-06T08:05:00'), post('2026-11-05T09:00:00')] });
    expect(r.posts[0]!.errors.join()).toMatch(/za wcześnie/);
    expect(r.posts[1]!.errors).toEqual([]);
    expect(r.posts[2]!.errors.join()).toMatch(/za wcześnie/);
    expect(r.plan_id).toBeNull();
    expect(r.summary.ready_to_commit).toBe(false);
  });

  it('długość posta: limit 3000 znaków liczony w znakach, nie bajtach', async () => {
    const { svc } = setup();
    const r = await svc.previewSeries({
      posts: [post('2026-11-06T09:00:00', { text: 'ż'.repeat(3000) }), post('2026-11-06T10:00:00', { text: 'a'.repeat(3001) })],
    });
    expect(r.posts[0]!.errors).toEqual([]);
    expect(r.posts[0]!.chars).toBe(3000);
    expect(r.posts[1]!.errors.join()).toMatch(/3001 znaków/);
  });

  it('pusta treść posta', async () => {
    const { svc } = setup();
    const r = await svc.previewSeries({ posts: [post('2026-11-06T09:00:00', { text: '   ' })] });
    expect(r.posts[0]!.errors.join()).toMatch(/pusta/);
  });

  it('duplikat treści w serii, w kolejce i względem opublikowanych', async () => {
    const { svc, clock, scheduler } = setup();
    const same = 'Ta sama treść';
    const inSeries = await svc.previewSeries({
      posts: [post('2026-11-06T09:00:00', { text: same }), post('2026-11-06T10:00:00', { text: 'ta  SAMA treść ' })],
    });
    expect(inSeries.posts[1]!.errors.join()).toMatch(/identyczna jak w poście nr 1/i);

    await commitOne(svc, '2026-11-06T09:00:00', { text: same });
    const inQueue = await svc.previewSeries({ posts: [post('2026-11-08T09:00:00', { text: same })] });
    expect(inQueue.posts[0]!.errors.join()).toMatch(/w kolejce/);

    clock.set('2026-11-06T08:00:00.000Z');
    await scheduler.tick();
    const published = await svc.previewSeries({ posts: [post('2026-11-08T09:00:00', { text: same })] });
    expect(published.posts[0]!.errors.join()).toMatch(/opublikowana/);
  });

  it('kolizje terminów w tym samym przebiegu (co 5 min) to ostrzeżenia, nie błędy', async () => {
    const { svc } = setup();
    await commitOne(svc, '2026-11-06T09:00:00');
    const r = await svc.previewSeries({
      posts: [post('2026-11-06T08:58:00'), post('2026-11-06T10:01:00'), post('2026-11-06T10:04:00')],
    });
    expect(r.plan_id).toBeTruthy();
    expect(r.posts[0]!.warnings.join()).toMatch(/Kolizja terminu z postem post_/);
    expect(r.posts[2]!.warnings.join()).toMatch(/Kolizja terminu z postem nr 2/);
    expect(r.posts[1]!.warnings.join()).toMatch(/wyjdzie o 2026-11-06T10:05:00\+01:00/);
  });

  it('[LINK] wymaga link_mode = later; later wymaga comment_text_no_link albo if_no_link = skip', async () => {
    const { svc } = setup();
    const r = await svc.previewSeries({
      posts: [
        post('2026-11-06T09:00:00', { comment_text: 'Link: [LINK]' }),
        post('2026-11-06T10:00:00', { comment_text: 'Link: [LINK]', link_mode: 'later' }),
        post('2026-11-06T11:00:00', { comment_text: 'Link: [LINK]', link_mode: 'later', if_no_link: 'skip' }),
        post('2026-11-06T12:00:00', { comment_text: 'Link: [LINK]', link_mode: 'later', comment_text_no_link: 'Link wkrótce' }),
        post('2026-11-06T13:00:00', { comment_text: 'Link: [LINK]', link_mode: 'later', if_no_link: 'post_without_link' }),
        post('2026-11-06T14:00:00', { text: 'Tekst z [LINK]' }),
        post('2026-11-06T15:00:00', { comment_text: 'Bez symbolu', link_mode: 'later', if_no_link: 'skip' }),
      ],
    });
    expect(r.posts[0]!.errors.join()).toMatch(/link_mode musi być later/);
    expect(r.posts[1]!.errors.join()).toMatch(/wymaga comment_text_no_link albo if_no_link = skip/);
    expect(r.posts[2]!.errors).toEqual([]);
    expect(r.posts[3]!.errors).toEqual([]);
    expect(r.posts[3]!.comment!.if_no_link).toBe('post_without_link');
    expect(r.posts[4]!.errors.join()).toMatch(/post_without_link wymaga comment_text_no_link/);
    expect(r.posts[5]!.errors.join()).toMatch(/tylko w komentarzu/);
    expect(r.posts[6]!.warnings.join()).toMatch(/nie zawiera \[LINK\]/);
  });

  it('czas: zła forma, nieistniejąca godzina wiosną, podwójna jesienią, własna strefa', async () => {
    const { svc } = setup({}, '2026-10-20T07:00:00.000Z');
    const r = await svc.previewSeries({
      posts: [post('2026-10-25 02:30'), post('2027-03-28T02:30:00'), post('2026-10-25T02:30:00')],
    });
    expect(r.posts[0]!.errors.join()).toMatch(/Niepoprawny termin/);
    expect(r.posts[1]!.errors.join()).toMatch(/nie istnieje/);
    expect(r.posts[2]!.errors).toEqual([]);
    expect(r.posts[2]!.warnings.join()).toMatch(/dwa razy/);
    expect(r.posts[2]!.publish_at_utc).toBe('2026-10-25T00:30:00.000Z');

    const ny = await svc.previewSeries({ timezone: 'America/New_York', posts: [post('2026-11-06T09:00:00')] });
    expect(ny.posts[0]!.publish_at_utc).toBe('2026-11-06T14:00:00.000Z');
    await expectToolError(svc.previewSeries({ timezone: 'Nie/Ma', posts: [post('2026-11-06T09:00:00')] }), 'invalid_timezone');
  });

  it('niepoprawne parametry -> invalid_arguments', async () => {
    const { svc } = setup();
    await expectToolError(svc.previewSeries({ posts: [] }), 'invalid_arguments');
    await expectToolError(svc.previewSeries({ posts: [{ text: 'x' }] }), 'invalid_arguments');
    await expectToolError(svc.previewSeries({ posts: [post('2026-11-06T09:00:00', { link_mode: 'soon' as never })] }), 'invalid_arguments');
  });
});

describe('linkedin_commit_series', () => {
  it('zapisuje dokładnie treść z podglądu; drugie zatwierdzenie = błąd, bez duplikatów', async () => {
    const { svc, store } = setup();
    const input = post('2026-11-06T09:00:00', { text: 'Linia 1\r\nLinia 2 #hashtag @wzmianka (nawias) *gwiazdka*' });
    const pv = await svc.previewSeries({ posts: [input] });
    const c = await svc.commitSeries({ plan_id: pv.plan_id });
    expect(c.series_id).toMatch(/^ser_/);
    expect(c.posts[0]).toMatchObject({ status: 'scheduled', publish_at_local: '2026-11-06T09:00:00+01:00', comment_status: 'waiting' });
    expect((await store.getPost(c.posts[0]!.id))!.text).toBe('Linia 1\nLinia 2 #hashtag @wzmianka (nawias) *gwiazdka*');

    const e = await expectToolError(svc.commitSeries({ plan_id: pv.plan_id }), 'plan_already_committed');
    expect(e.details).toEqual({ series_id: c.series_id });
    expect(await store.listPosts()).toHaveLength(1);
  });

  it('wygaśnięcie plan_id (PLAN_TTL_MIN)', async () => {
    const { svc, clock } = setup();
    const pv = await svc.previewSeries({ posts: [post('2026-11-07T09:00:00')] });
    clock.advanceMin(30);
    await expectToolError(svc.commitSeries({ plan_id: pv.plan_id }), 'plan_expired');
  });

  it('wygasły plan usunięty przez harmonogram -> plan_not_found', async () => {
    const { svc, clock, scheduler } = setup();
    const pv = await svc.previewSeries({ posts: [post('2026-11-07T09:00:00')] });
    clock.advanceMin(31);
    await scheduler.tick();
    await expectToolError(svc.commitSeries({ plan_id: pv.plan_id }), 'plan_not_found');
    await expectToolError(svc.commitSeries({ plan_id: 'plan_nieistnieje' }), 'plan_not_found');
  });

  it('ponowna kontrola przy zatwierdzeniu: termin zbyt bliski po upływie czasu', async () => {
    const { svc, clock } = setup();
    const pv = await svc.previewSeries({ posts: [post('2026-11-06T08:20:00')] }); // 20 min w przód
    clock.advanceMin(16);
    const e = await expectToolError(svc.commitSeries({ plan_id: pv.plan_id }), 'plan_no_longer_valid');
    expect(JSON.stringify(e.details)).toMatch(/bliżej niż 5 min/);
  });

  it('ponowna kontrola przy zatwierdzeniu: duplikat zatwierdzony w międzyczasie', async () => {
    const { svc } = setup();
    const a = await svc.previewSeries({ posts: [post('2026-11-06T09:00:00', { text: 'Unikat' })] });
    const b = await svc.previewSeries({ posts: [post('2026-11-06T10:00:00', { text: 'Unikat' })] });
    await svc.commitSeries({ plan_id: a.plan_id });
    await expectToolError(svc.commitSeries({ plan_id: b.plan_id }), 'plan_no_longer_valid');
  });
});

describe('linkedin_list_queue i linkedin_get_post', () => {
  it('filtry status, series_id, from, to (czas lokalny) i pełne dane z historią', async () => {
    const { svc } = setup();
    const a = await commitOne(svc, '2026-11-06T09:00:00');
    const b = await commitOne(svc, '2026-11-08T09:00:00');
    await svc.cancelPost({ id: b.id });

    expect((await svc.listQueue({})).count).toBe(2);
    expect((await svc.listQueue({ status: 'scheduled' })).posts.map((p) => p.id)).toEqual([a.id]);
    expect((await svc.listQueue({ from: '2026-11-07' })).posts.map((p) => p.id)).toEqual([b.id]);
    expect((await svc.listQueue({ to: '2026-11-06' })).posts.map((p) => p.id)).toEqual([a.id]);
    expect((await svc.listQueue({ from: '2026-11-06T09:00', to: '2026-11-06T09:00' })).count).toBe(1);
    const item = (await svc.listQueue({ status: 'scheduled' })).posts[0]!;
    expect(item).toMatchObject({ publish_at_local: '2026-11-06T09:00:00+01:00', status: 'scheduled', comment_status: 'waiting', post_url: null, last_error: null });
    expect(item.text_start.length).toBeLessThanOrEqual(81);
    await expectToolError(svc.listQueue({ status: 'zly' }), 'invalid_arguments');
    await expectToolError(svc.listQueue({ from: 'jutro' }), 'invalid_datetime');

    const full = await svc.getPost({ id: b.id });
    expect(full.status).toBe('canceled');
    expect(full.events.map((e) => e.type)).toEqual(['created', 'canceled']);
    await expectToolError(svc.getPost({ id: 'post_x' }), 'post_not_found');
  });
});

describe('linkedin_update_post', () => {
  it('zmienia treść, termin i komentarz przed publikacją', async () => {
    const { svc } = setup();
    const p = await commitOne(svc);
    const u = await svc.updatePost({ id: p.id, text: 'Nowa treść', publish_at: '2026-11-06T11:00:00', comment_text: '' });
    expect(u).toMatchObject({ text: 'Nowa treść', publish_at_local: '2026-11-06T11:00:00+01:00', comment_status: 'none' });
    const full = await svc.getPost({ id: p.id });
    expect(full.events.at(-1)).toMatchObject({ type: 'updated' });
  });

  it('odrzuca, gdy do publikacji zostało mniej niż 5 minut albo nowy termin jest za blisko', async () => {
    const { svc, clock } = setup();
    const p = await commitOne(svc, '2026-11-06T08:30:00');
    await expectToolError(svc.updatePost({ id: p.id, publish_at: '2026-11-06T08:03:00' }), 'validation_failed');
    clock.set('2026-11-06T07:26:00.000Z');
    await expectToolError(svc.updatePost({ id: p.id, text: 'późno' }), 'too_close_to_publish');
  });

  it('odrzuca dla statusów innych niż scheduled/missed', async () => {
    const { svc, clock, scheduler } = setup();
    const p = await commitOne(svc);
    clock.set('2026-11-06T08:00:00.000Z');
    await scheduler.tick();
    await expectToolError(svc.updatePost({ id: p.id, text: 'x' }), 'not_editable');
    const c = await commitOne(svc, '2026-11-07T09:00:00');
    await svc.cancelPost({ id: c.id });
    await expectToolError(svc.updatePost({ id: c.id, text: 'x' }), 'not_editable');
  });

  it('post missed: wymaga nowego terminu, potem wraca do scheduled', async () => {
    const { svc, clock, scheduler } = setup();
    const p = await commitOne(svc);
    clock.set('2026-11-06T10:00:00.000Z'); // 2 h po terminie
    await scheduler.tick();
    expect((await svc.getPost({ id: p.id })).status).toBe('missed');
    await expectToolError(svc.updatePost({ id: p.id, text: 'Nowa' }), 'missed_requires_new_time');
    const u = await svc.updatePost({ id: p.id, publish_at: '2026-11-06T12:00:00' });
    expect(u.status).toBe('scheduled');
    clock.set('2026-11-06T11:00:00.000Z');
    expect((await scheduler.tick()).published).toEqual([p.id]);
  });

  it('walidacje treści i duplikatów przy edycji; brak pól = błąd', async () => {
    const { svc } = setup();
    const a = await commitOne(svc, '2026-11-06T09:00:00', { text: 'Treść A' });
    const b = await commitOne(svc, '2026-11-06T10:00:00', { text: 'Treść B' });
    await expectToolError(svc.updatePost({ id: b.id, text: 'Treść A' }), 'validation_failed');
    await expectToolError(svc.updatePost({ id: b.id, text: 'x'.repeat(3001) }), 'validation_failed');
    await expectToolError(svc.updatePost({ id: a.id, comment_text: 'Zobacz [LINK]' }), 'validation_failed');
    await expectToolError(svc.updatePost({ id: a.id }), 'nothing_to_update');
    expect((await svc.updatePost({ id: a.id, text: 'Treść A' })).text).toBe('Treść A'); // ta sama treść tego samego posta
  });
});

describe('linkedin_cancel_post', () => {
  it('anuluje scheduled (z komentarzem), odrzuca opublikowane i już anulowane', async () => {
    const { svc, clock, scheduler } = setup();
    const a = await commitOne(svc);
    const c = await svc.cancelPost({ id: a.id });
    expect(c).toMatchObject({ status: 'canceled', comment_status: 'skipped' });
    await expectToolError(svc.cancelPost({ id: a.id }), 'not_cancelable');
    const b = await commitOne(svc, '2026-11-06T09:00:00');
    clock.set('2026-11-06T08:00:00.000Z');
    await scheduler.tick();
    await expectToolError(svc.cancelPost({ id: b.id }), 'not_cancelable');
  });
});

describe('linkedin_set_comment_link (tryb later)', () => {
  const later = { comment_text: 'Artykuł: [LINK]', link_mode: 'later' as const, comment_text_no_link: 'Artykuł wkrótce' };

  it('podstawia link w miejsce [LINK] i komentarz wychodzi z linkiem', async () => {
    const { svc, clock, scheduler, mock } = setup();
    const p = await commitOne(svc, '2026-11-06T09:00:00', later);
    expect(p.comment_status).toBe('waiting_link');
    const r = await svc.setCommentLink({ id: p.id, url: 'https://example.com/artykul?utm=li' });
    expect(r).toMatchObject({ comment_status: 'waiting', comment_url: 'https://example.com/artykul?utm=li' });
    expect(r.comment_preview).toBe('Artykuł: https://example.com/artykul?utm=li');
    clock.set('2026-11-06T08:00:00.000Z');
    await scheduler.tick();
    // link można jeszcze zmienić po publikacji posta, przed komentarzem
    await svc.setCommentLink({ id: p.id, url: 'https://example.com/v2' });
    clock.set('2026-11-06T08:10:00.000Z');
    await scheduler.tick();
    expect(mock.posts[0]!.comments[0]!.text).toBe('Artykuł: https://example.com/v2');
    await expectToolError(svc.setCommentLink({ id: p.id, url: 'https://example.com/v3' }), 'comment_not_pending');
  });

  it('odrzuca niepoprawny URL i posty bez trybu later', async () => {
    const { svc } = setup();
    const p = await commitOne(svc, '2026-11-06T09:00:00', later);
    for (const url of ['example.com', 'ftp://example.com/x', 'javascript:alert(1)', 'https://exa mple.com', 'http://']) {
      await expectToolError(svc.setCommentLink({ id: p.id, url }), 'invalid_url');
    }
    const plain = await commitOne(svc, '2026-11-06T10:00:00');
    await expectToolError(svc.setCommentLink({ id: plain.id, url: 'https://example.com' }), 'not_link_later');
  });
});

describe('linkedin_auth_status', () => {
  it('pola z kontraktu, can_comment: unknown -> yes po pierwszym komentarzu', async () => {
    const { svc, clock, scheduler } = setup();
    const s = await svc.authStatus();
    expect(s).toMatchObject({
      connected: true,
      profile_name: 'KTBnet (atrapa)',
      expires_at: '2026-12-31T00:00:00.000Z',
      days_left: 54,
      login_url: 'http://127.0.0.1:47811/oauth/start',
      can_post: true,
      can_comment: 'unknown',
      mode: 'mock',
      paused: false,
    });
    await commitOne(svc);
    clock.set('2026-11-06T08:00:00.000Z');
    await scheduler.tick(); // publikacja
    clock.advanceMin(10);
    await scheduler.tick(); // komentarz
    expect((await svc.authStatus()).can_comment).toBe('yes');
  });

  it('ostrzeżenia: rozłączony, pauza, wygasające logowanie; brak tokenów w odpowiedzi', async () => {
    const { svc, mock, config, clock } = setup();
    setPause(config.paths.pauseFlagFile, null);
    clock.set('2026-12-27T00:00:00.000Z');
    const s = await svc.authStatus();
    expect(s.days_left).toBe(4);
    expect(s.warnings.join(' ')).toMatch(/wygasa za 4 dni/);
    expect(s.warnings.join(' ')).toMatch(/PAUSE/);
    expect(JSON.stringify(s)).not.toMatch(/token/i);
    mock.setScenario({ auth: 'disconnected' });
    const d = await svc.authStatus();
    expect(d).toMatchObject({ connected: false, can_post: false });
    expect(d.warnings.join(' ')).toMatch(/Zaloguj się/);
  });
});

describe('dziennik audytu', () => {
  it('każda operacja narzędzia trafia do audytu', async () => {
    const { svc, store } = setup();
    const p = await commitOne(svc);
    await svc.listQueue({});
    await svc.getPost({ id: p.id });
    await svc.cancelPost({ id: p.id });
    await expectToolError(svc.cancelPost({ id: p.id }), 'not_cancelable');
    const actions = (await store.listAudit()).map((a) => `${a.action}:${a.result}`).reverse();
    expect(actions).toEqual([
      'linkedin_preview_series:ok',
      'linkedin_commit_series:ok',
      'linkedin_list_queue:ok',
      'linkedin_get_post:ok',
      'linkedin_cancel_post:ok',
      'linkedin_cancel_post:rejected',
    ]);
  });
});
