import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LinkedInError, MockLinkedIn, clearPause, readPause, setPause } from '../src/core/index.js';
import { tmpDataDir } from './helpers.js';

const input = { text: 'Cześć #LinkedIn (test) & „cudzysłów”', idempotencyKey: 'idem_1' };

async function expectKind(p: Promise<unknown>, kind: string, ambiguous: boolean) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LinkedInError);
  expect((err as LinkedInError).kind).toBe(kind);
  expect((err as LinkedInError).ambiguous).toBe(ambiguous);
}

describe('atrapa LinkedIn', () => {
  it('ok: publikuje post i komentarz, zachowuje treść bez zmian', async () => {
    const m = new MockLinkedIn();
    const r = await m.publishPost(input);
    expect(r.postUrn).toMatch(/^urn:li:share:/);
    expect(r.postUrl).toContain(r.postUrn);
    const c = await m.addComment({ postUrn: r.postUrn, text: 'Komentarz', idempotencyKey: 'c1' });
    expect(c.commentUrn).toContain(r.postUrn);
    expect(m.posts[0]!.text).toBe(input.text);
    expect(m.posts[0]!.comments).toHaveLength(1);
  });

  it('checkAuth: połączony, rozłączony, bez uprawnień do publikacji', async () => {
    const m = new MockLinkedIn();
    expect((await m.checkAuth()).connected).toBe(true);
    expect((await m.checkAuth()).personUrn).toMatch(/^urn:li:organization:/); // atrapa "publikuje" jako strona firmy
    m.setScenario({ auth: 'disconnected' });
    expect((await m.checkAuth()).connected).toBe(false);
    m.setScenario({ auth: 'no_post_permission' });
    expect((await m.checkAuth()).canPost).toBe(false);
  });

  it('odmowa (reject) - jednoznaczna, post nie powstaje', async () => {
    const m = new MockLinkedIn({ scenario: { publish: 'reject' } });
    await expectKind(m.publishPost(input), 'rejected', false);
    expect(m.posts).toHaveLength(0);
  });

  it('timeout - niejednoznaczny, post POWSTAJE mimo błędu', async () => {
    const m = new MockLinkedIn({ scenario: { publish: 'timeout' } });
    await expectKind(m.publishPost(input), 'timeout', true);
    expect(m.posts).toHaveLength(1);
  });

  it('błąd niejednoznaczny (ambiguous) - post powstaje', async () => {
    const m = new MockLinkedIn({ scenario: { publish: 'ambiguous' } });
    await expectKind(m.publishPost(input), 'ambiguous', true);
    expect(m.posts).toHaveLength(1);
  });

  it('unauthorized, rate_limited, network - jednoznaczne', async () => {
    for (const [mode, kind] of [
      ['unauthorized', 'unauthorized'],
      ['rate_limited', 'rate_limited'],
      ['network', 'network'],
    ] as const) {
      const m = new MockLinkedIn({ scenario: { publish: mode } });
      await expectKind(m.publishPost(input), kind, false);
      expect(m.posts).toHaveLength(0);
    }
  });

  it('brak uprawnień do komentarza (forbidden)', async () => {
    const m = new MockLinkedIn();
    const r = await m.publishPost(input);
    m.setScenario({ comment: 'forbidden' });
    await expectKind(m.addComment({ postUrn: r.postUrn, text: 'x', idempotencyKey: 'c' }), 'forbidden', false);
    expect(m.posts[0]!.comments).toHaveLength(0);
  });

  it('timeout komentarza - komentarz powstaje mimo błędu', async () => {
    const m = new MockLinkedIn();
    const r = await m.publishPost(input);
    m.setScenario({ comment: 'timeout' });
    await expectKind(m.addComment({ postUrn: r.postUrn, text: 'x', idempotencyKey: 'c' }), 'timeout', true);
    expect(m.posts[0]!.comments).toHaveLength(1);
  });

  it('scenariusz z licznikiem "times" wraca do ok', async () => {
    const m = new MockLinkedIn({ scenario: { publish: { mode: 'reject', times: 1 } } });
    await expectKind(m.publishPost(input), 'rejected', false);
    await expect(m.publishPost(input)).resolves.toBeTruthy();
  });

  it('scenariusz z pliku jest czytany przy każdym wywołaniu, a stan przetrwa restart', async () => {
    const dir = tmpDataDir();
    const scenarioFile = path.join(dir, 'mock-scenario.json');
    const stateFile = path.join(dir, 'mock-linkedin.json');
    const m = new MockLinkedIn({ scenarioFile, stateFile });
    await m.publishPost(input);
    fs.writeFileSync(scenarioFile, JSON.stringify({ publish: 'reject' }));
    await expectKind(m.publishPost(input), 'rejected', false);
    const restarted = new MockLinkedIn({ scenarioFile, stateFile });
    expect(restarted.posts).toHaveLength(1);
  });
});

describe('bezpiecznik PAUSE', () => {
  it('włącza i wyłącza pauzę plikiem flagi', () => {
    const flag = path.join(tmpDataDir(), 'PAUSE');
    expect(readPause(flag).paused).toBe(false);
    setPause(flag, 'test');
    expect(readPause(flag)).toMatchObject({ paused: true, reason: 'test' });
    fs.writeFileSync(flag, ''); // pusty plik też oznacza pauzę
    expect(readPause(flag).paused).toBe(true);
    clearPause(flag);
    expect(readPause(flag).paused).toBe(false);
  });
});
