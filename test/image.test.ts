import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeClock,
  LinkedInService,
  MockLinkedIn,
  Scheduler,
  SqliteStore,
  ToolError,
  createCore,
  detectImage,
} from '../src/core/index.js';
import { testConfig, tmpDataDir } from './helpers.js';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF_1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// Minimalny nagłówek JPEG: SOI, APP0 (JFIF), SOF0 z wysokością 200 i szerokością 300.
const JPEG_300x200 = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'binary'),
  Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.from([0xff, 0xd9]),
]);

const T0 = '2026-11-06T07:00:00.000Z';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup(env: Record<string, string> = {}) {
  const config = testConfig(env);
  const clock = new FakeClock(T0);
  const mock = new MockLinkedIn();
  const store = new SqliteStore(':memory:');
  cleanups.push(() => store.close());
  const ctx = createCore(config, { store, linkedin: mock, clock, auditFile: null });
  return { ctx, clock, mock, store, config, svc: new LinkedInService(ctx), scheduler: new Scheduler(ctx) };
}

function writeFile(name: string, data: Buffer): string {
  const f = path.join(tmpDataDir(), name);
  fs.writeFileSync(f, data);
  return f;
}

let n = 0;
const post = (extra: Record<string, unknown> = {}) => ({ text: `Post z obrazem ${++n}`, publish_at: '2026-11-06T09:00:00', comment_text: 'Komentarz', ...extra });

describe('rozpoznawanie obrazów po nagłówku', () => {
  it('PNG, GIF, JPEG z wymiarami; inne pliki odrzucone', () => {
    expect(detectImage(PNG_1x1)).toEqual({ mime: 'image/png', ext: 'png', width: 1, height: 1 });
    expect(detectImage(GIF_1x1)).toEqual({ mime: 'image/gif', ext: 'gif', width: 1, height: 1 });
    expect(detectImage(JPEG_300x200)).toEqual({ mime: 'image/jpeg', ext: 'jpg', width: 300, height: 200 });
    expect(detectImage(Buffer.from('%PDF-1.7 ...'))).toBeNull();
    expect(detectImage(Buffer.from('to jest zwykły tekst udający png'))).toBeNull();
  });
});

describe('obraz w linkedin_preview_series', () => {
  it('poprawny obraz: dane w podglądzie, kopia w katalogu danych, ostrzeżenie o braku alt', async () => {
    const { svc, config } = setup();
    const src = writeFile('grafika.png', PNG_1x1);
    const r = await svc.previewSeries({ posts: [post({ image_path: src }), post({ image_path: src, image_alt: 'Wykres', publish_at: '2026-11-06T10:00:00' })] });
    expect(r.plan_id).toBeTruthy();
    expect(r.posts[0]!.image).toEqual({ file_name: 'grafika.png', mime: 'image/png', bytes: PNG_1x1.length, width: 1, height: 1, alt: '' });
    expect(r.posts[0]!.warnings.join()).toMatch(/tekstu alternatywnego/);
    expect(r.posts[1]!.warnings).toEqual([]);
    expect(r.summary.with_image).toBe(2);
    expect(fs.readdirSync(config.paths.imagesDir)).toHaveLength(1); // ta sama treść = jedna kopia
  });

  it('błędy: brak pliku, ścieżka względna, katalog, zły format (także przemianowany), za duży', async () => {
    const { svc } = setup({ IMAGE_MAX_MB: '1' });
    const fake = writeFile('udaje.png', Buffer.from('to nie jest obraz'));
    const big = writeFile('duzy.png', Buffer.concat([PNG_1x1, Buffer.alloc(1_100_000)]));
    const r = await svc.previewSeries({
      posts: [
        post({ image_path: 'C:\\nie\\ma\\takiego\\pliku.png' }),
        post({ image_path: 'grafika.png' }),
        post({ image_path: tmpDataDir() }),
        post({ image_path: fake }),
        post({ image_path: big }),
      ],
    });
    expect(r.plan_id).toBeNull();
    expect(r.posts.map((p) => p.errors.join())).toEqual([
      expect.stringMatching(/Nie znaleziono pliku/),
      expect.stringMatching(/pełna/),
      expect.stringMatching(/To nie jest plik/),
      expect.stringMatching(/Nieobsługiwany format/),
      expect.stringMatching(/limit to 1 MB/),
    ]);
  });

  it('ścieżka w cudzysłowie (skopiowana z Eksploratora) jest akceptowana', async () => {
    const { svc } = setup();
    const src = writeFile('z cudzyslowem.gif', GIF_1x1);
    const r = await svc.previewSeries({ posts: [post({ image_path: `"${src}"` })] });
    expect(r.posts[0]!.errors).toEqual([]);
    expect(r.posts[0]!.image!.mime).toBe('image/gif');
  });
});

describe('obraz: zatwierdzenie, publikacja, edycja', () => {
  it('publikuje zatwierdzoną kopię, nawet gdy oryginał zmieniono lub usunięto', async () => {
    const { svc, clock, scheduler, mock } = setup();
    const src = writeFile('grafika.jpg', JPEG_300x200);
    const pv = await svc.previewSeries({ posts: [post({ image_path: src, image_alt: 'Grafika testowa' })] });
    const c = await svc.commitSeries({ plan_id: pv.plan_id });
    fs.writeFileSync(src, GIF_1x1); // użytkownik podmienia plik...
    fs.rmSync(src); // ...albo go usuwa
    clock.set('2026-11-06T08:00:00.000Z');
    expect((await scheduler.tick()).published).toEqual([c.posts[0]!.id]);
    expect(mock.posts[0]!.image).toMatchObject({ mime: 'image/jpeg', bytes: JPEG_300x200.length, alt: 'Grafika testowa' });
    expect(mock.posts[0]!.image!.urn).toMatch(/^urn:li:image:/);
    expect(mock.calls.uploadImage).toBe(1);
    const full = await svc.getPost({ id: c.posts[0]!.id });
    expect(full.image).toMatchObject({ file_name: 'grafika.jpg', width: 300, height: 200 });
  });

  it('błąd wysyłania obrazu = jednoznaczny, post nie powstaje, brak ponawiania', async () => {
    const { svc, clock, scheduler, mock } = setup();
    mock.setScenario({ image: 'reject' });
    const pv = await svc.previewSeries({ posts: [post({ image_path: writeFile('a.png', PNG_1x1) })] });
    const c = await svc.commitSeries({ plan_id: pv.plan_id });
    clock.set('2026-11-06T08:00:00.000Z');
    expect((await scheduler.tick()).failed).toEqual([c.posts[0]!.id]);
    const p = await svc.getPost({ id: c.posts[0]!.id });
    expect(p.last_error).toMatchObject({ code: 'linkedin_rejected', ambiguous: false });
    expect(mock.posts).toHaveLength(0);
    mock.setScenario({});
    clock.advanceMin(5);
    await scheduler.tick();
    expect(mock.calls.publishPost).toBe(1);
  });

  it('usunięta kopia w katalogu danych -> failed image_missing, bez wysyłania', async () => {
    const { svc, clock, scheduler, mock, config } = setup();
    const pv = await svc.previewSeries({ posts: [post({ image_path: writeFile('b.png', PNG_1x1) })] });
    const c = await svc.commitSeries({ plan_id: pv.plan_id });
    for (const f of fs.readdirSync(config.paths.imagesDir)) fs.rmSync(path.join(config.paths.imagesDir, f));
    clock.set('2026-11-06T08:00:00.000Z');
    await scheduler.tick();
    expect((await svc.getPost({ id: c.posts[0]!.id })).last_error).toMatchObject({ code: 'image_missing' });
    expect(mock.calls.publishPost).toBe(0);
  });

  it('linkedin_update_post: dodanie, zmiana alt, usunięcie obrazu; walidacje', async () => {
    const { svc } = setup();
    const pv = await svc.previewSeries({ posts: [post()] });
    const id = (await svc.commitSeries({ plan_id: pv.plan_id })).posts[0]!.id;

    const e = await svc.updatePost({ id, image_alt: 'x' }).catch((err: unknown) => err);
    expect((e as ToolError).code).toBe('validation_failed');

    const added = await svc.updatePost({ id, image_path: writeFile('c.gif', GIF_1x1), image_alt: 'Animacja' });
    expect(added.image).toMatchObject({ mime: 'image/gif', alt: 'Animacja' });
    expect((await svc.updatePost({ id, image_alt: 'Nowy opis' })).image!.alt).toBe('Nowy opis');

    const both = await svc.updatePost({ id, image_path: writeFile('d.png', PNG_1x1), remove_image: true }).catch((err: unknown) => err);
    expect((both as ToolError).code).toBe('validation_failed');

    const bad = await svc.updatePost({ id, image_path: writeFile('e.png', Buffer.from('nie obraz')) }).catch((err: unknown) => err);
    expect((bad as ToolError).code).toBe('validation_failed');

    expect((await svc.updatePost({ id, remove_image: true })).image).toBeNull();
  });
});
