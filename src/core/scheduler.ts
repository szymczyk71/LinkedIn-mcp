import type { PostPatch } from './db/store.js';
import type { CoreContext } from './index.js';
import { LinkedInError } from './linkedin/client.js';
import { silentLogger, type Logger } from './logger.js';
import type { CanComment, Post, PostError } from './model.js';
import { readPause } from './pause.js';
import { decideComment } from './posts.js';
import { minutesBetween } from './time.js';
import { addMinutes } from './util.js';

export interface TickResult {
  at: string;
  paused: boolean;
  published: string[];
  missed: string[];
  failed: string[];
  commentsDone: string[];
  commentsSkipped: string[];
  commentsFailed: string[];
  expiredPlansDeleted: number;
}

export interface RecoveryResult {
  interruptedPosts: string[];
  interruptedComments: string[];
}

const AMBIGUOUS_HINT =
  'Nie wiadomo, czy obiekt powstał na LinkedIn. Serwer nie ponawia automatycznie, żeby nie zdublować - sprawdź profil ręcznie.';

/**
 * Logika jednego przebiegu harmonogramu (niezależna od Bree, więc łatwa do testowania).
 *
 * Kolejność w przebiegu:
 * 1. usunięcie wygasłych, niezatwierdzonych planów,
 * 2. polityka "missed": posty spóźnione o >= MISSED_GRACE_MIN dostają status missed (także przy pauzie),
 * 3. jeśli nie ma pauzy: publikacja pozostałych zaległych postów,
 * 4. jeśli nie ma pauzy: komentarze, których termin minął.
 *
 * Każda publikacja zaczyna się od warunkowego przejścia scheduled -> publishing ("blokada wiersza"),
 * więc post może opublikować tylko jeden proces i tylko raz.
 */
export class Scheduler {
  constructor(
    private readonly ctx: CoreContext,
    private readonly log: Logger = silentLogger,
  ) {}

  private nowIso(): string {
    return this.ctx.clock.now().toISOString();
  }

  private paused(): boolean {
    return readPause(this.ctx.config.paths.pauseFlagFile).paused;
  }

  /**
   * Po starcie procesu: posty i komentarze przerwane w trakcie wysyłania oznaczamy jako błąd
   * niejednoznaczny. Nie ponawiamy ich, bo mogły już powstać na LinkedIn.
   */
  async recoverOnStartup(): Promise<RecoveryResult> {
    const { store, audit } = this.ctx;
    const now = this.nowIso();
    const result: RecoveryResult = { interruptedPosts: [], interruptedComments: [] };

    for (const p of await store.listPosts({ status: 'publishing', limit: 10_000 })) {
      const err: PostError = {
        code: 'publish_interrupted',
        message: `Publikacja przerwana (restart lub awaria workera). ${AMBIGUOUS_HINT}`,
        ambiguous: true,
        at: now,
      };
      const upd = await store.transitionPost(p.id, ['publishing'], { status: 'failed', lastError: err, ...skipCommentAfterFailure(p, now) }, now);
      if (upd) {
        result.interruptedPosts.push(p.id);
        await store.addEvent(p.id, 'publish_interrupted', { error: err }, now);
        await audit.record('scheduler', 'recover_publishing', 'error', p.id, { error: err });
        this.log.warn('Przerwana publikacja oznaczona jako failed (niejednoznaczne)', { postId: p.id });
      }
    }

    for (const p of await store.findClaimedComments()) {
      const err: PostError = {
        code: 'comment_interrupted',
        message: `Dodawanie komentarza przerwane (restart lub awaria workera). ${AMBIGUOUS_HINT}`,
        ambiguous: true,
        at: now,
      };
      const upd = await store.transitionPost(p.id, ['published'], { commentStatus: 'failed', commentError: err }, now, p.version);
      if (upd) {
        result.interruptedComments.push(p.id);
        await store.addEvent(p.id, 'comment_interrupted', { error: err }, now);
        await audit.record('scheduler', 'recover_comment', 'error', p.id, { error: err });
      }
    }
    return result;
  }

  async tick(): Promise<TickResult> {
    const { store, config, audit } = this.ctx;
    const at = this.nowIso();
    const r: TickResult = {
      at,
      paused: false,
      published: [],
      missed: [],
      failed: [],
      commentsDone: [],
      commentsSkipped: [],
      commentsFailed: [],
      expiredPlansDeleted: await store.deleteExpiredPlans(at),
    };

    const due = await store.findDuePosts(at);
    const toPublish: Post[] = [];
    for (const p of due) {
      const lateMin = minutesBetween(p.publishAtUtc, at);
      if (lateMin < config.missedGraceMin) {
        toPublish.push(p);
        continue;
      }
      const upd = await store.transitionPost(p.id, ['scheduled'], { status: 'missed' }, at);
      if (upd) {
        r.missed.push(p.id);
        const detail = { publishAtUtc: p.publishAtUtc, lateMin: Math.round(lateMin), graceMin: config.missedGraceMin };
        await store.addEvent(p.id, 'missed', detail, at);
        await audit.record('scheduler', 'mark_missed', 'ok', p.id, detail);
        this.log.warn('Post po terminie ponad próg - oznaczony jako missed, nie publikuję', { postId: p.id, ...detail });
      }
    }

    r.paused = this.paused();
    if (r.paused) {
      if (toPublish.length) this.log.info('Pauza (PAUSE) - pomijam publikację', { waiting: toPublish.length });
      return r;
    }

    for (const p of toPublish) {
      if (this.paused()) {
        r.paused = true;
        return r;
      }
      const outcome = await this.publishOne(p);
      if (outcome === 'published') r.published.push(p.id);
      else if (outcome === 'failed') r.failed.push(p.id);
    }

    for (const p of await store.findDueComments(this.nowIso())) {
      if (this.paused()) {
        r.paused = true;
        return r;
      }
      const outcome = await this.commentOne(p);
      if (outcome === 'done') r.commentsDone.push(p.id);
      else if (outcome === 'skipped') r.commentsSkipped.push(p.id);
      else if (outcome === 'failed') r.commentsFailed.push(p.id);
    }
    return r;
  }

  private async publishOne(post: Post): Promise<'published' | 'failed' | 'not_claimed'> {
    const { store, linkedin, audit } = this.ctx;
    const claimedAt = this.nowIso();
    const claimed = await store.transitionPost(post.id, ['scheduled'], { status: 'publishing' }, claimedAt);
    if (!claimed) return 'not_claimed';
    await store.addEvent(post.id, 'publishing', null, claimedAt);

    try {
      const res = await linkedin.publishPost({ text: claimed.text, idempotencyKey: claimed.idempotencyKey });
      const now = this.nowIso();
      const commentDueUtc = claimed.commentStatus === 'none' ? null : addMinutes(now, claimed.commentDelayMin);
      // 'failed' dopuszczamy na wypadek, gdyby recoverOnStartup innego procesu zdążył oznaczyć post,
      // a publikacja jednak się udała - wynik z LinkedIn jest wtedy rozstrzygający.
      const done = await store.transitionPost(
        post.id,
        ['publishing', 'failed'],
        { status: 'published', linkedinPostUrn: res.postUrn, postUrl: res.postUrl, publishedAtUtc: now, commentDueUtc, lastError: null },
        now,
      );
      await store.addEvent(post.id, 'published', { postUrl: res.postUrl, commentDueUtc }, now);
      await audit.record('scheduler', 'publish_post', 'ok', post.id, { postUrn: res.postUrn, postUrl: res.postUrl });
      this.log.info('Opublikowano post', { postId: post.id, postUrl: res.postUrl });
      return done ? 'published' : 'failed';
    } catch (e) {
      const now = this.nowIso();
      const err = toPostError(e, now);
      await store.transitionPost(post.id, ['publishing'], { status: 'failed', lastError: err, ...skipCommentAfterFailure(claimed, now) }, now);
      await store.addEvent(post.id, 'publish_failed', { error: err }, now);
      await audit.record('scheduler', 'publish_post', 'error', post.id, { error: err });
      this.log.error('Publikacja nie powiodła się', { postId: post.id, error: err });
      return 'failed';
    }
  }

  private async commentOne(post: Post): Promise<'done' | 'skipped' | 'failed' | 'not_claimed'> {
    const { store, linkedin, audit, config } = this.ctx;
    const now = this.nowIso();

    // Komentarz spóźniony ponad próg (worker był wyłączony) - pomijamy, tak jak posty "missed".
    if (post.commentDueUtc && minutesBetween(post.commentDueUtc, now) >= config.missedGraceMin) {
      const err: PostError = { code: 'comment_missed', message: 'Termin komentarza minął, gdy worker nie działał.', at: now };
      const upd = await store.transitionPost(post.id, ['published'], { commentStatus: 'skipped', commentError: err }, now, post.version);
      if (!upd) return 'not_claimed';
      await store.addEvent(post.id, 'comment_skipped', { reason: err.code }, now);
      await audit.record('scheduler', 'comment', 'rejected', post.id, { reason: err.code });
      return 'skipped';
    }

    const decision = decideComment(post);
    if (decision.action === 'skip') {
      const upd = await store.transitionPost(post.id, ['published'], { commentStatus: 'skipped' }, now, post.version);
      if (!upd) return 'not_claimed';
      await store.addEvent(post.id, 'comment_skipped', { reason: decision.reason }, now);
      await audit.record('scheduler', 'comment', 'rejected', post.id, { reason: 'no_link_skip' });
      return 'skipped';
    }

    const claimed = await store.transitionPost(post.id, ['published'], { commentClaimedAt: now }, now, post.version);
    if (!claimed) return 'not_claimed';

    try {
      const res = await linkedin.addComment({
        postUrn: claimed.linkedinPostUrn!,
        text: decision.text,
        idempotencyKey: `${claimed.idempotencyKey}:comment`,
      });
      const t = this.nowIso();
      await store.transitionPost(post.id, ['published'], { commentStatus: 'done', linkedinCommentUrn: res.commentUrn, commentError: null }, t);
      await store.addEvent(post.id, 'comment_done', { usedFallback: decision.usedFallback }, t);
      await audit.record('scheduler', 'comment', 'ok', post.id, { commentUrn: res.commentUrn, usedFallback: decision.usedFallback });
      await this.setCanComment('yes');
      return 'done';
    } catch (e) {
      const t = this.nowIso();
      const err = toPostError(e, t);
      const forbidden = e instanceof LinkedInError && e.kind === 'forbidden';
      // Brak uprawnień = "skipped" (kontrakt), pozostałe błędy = "failed" bez ponawiania.
      await store.transitionPost(post.id, ['published'], { commentStatus: forbidden ? 'skipped' : 'failed', commentError: err }, t);
      await store.addEvent(post.id, forbidden ? 'comment_skipped' : 'comment_failed', { error: err }, t);
      await audit.record('scheduler', 'comment', 'error', post.id, { error: err });
      if (forbidden) await this.setCanComment('no');
      this.log.error('Komentarz nie został dodany', { postId: post.id, error: err });
      return forbidden ? 'skipped' : 'failed';
    }
  }

  private async setCanComment(value: CanComment): Promise<void> {
    const { store } = this.ctx;
    const meta = await store.getAuthMeta();
    if (meta?.canComment === value) return;
    await store.setAuthMeta({
      personUrn: meta?.personUrn ?? null,
      profileName: meta?.profileName ?? null,
      profileUrl: meta?.profileUrl ?? null,
      expiresAt: meta?.expiresAt ?? null,
      scopes: meta?.scopes ?? [],
      canComment: value,
      updatedAt: this.nowIso(),
    });
  }
}

function skipCommentAfterFailure(p: Post, now: string): PostPatch {
  if (p.commentStatus === 'none') return {};
  return { commentStatus: 'skipped', commentError: { code: 'post_not_published', message: 'Post nie został opublikowany.', at: now } };
}

export function toPostError(e: unknown, at: string): PostError {
  if (e instanceof LinkedInError) {
    return { code: e.code, message: e.ambiguous ? `${e.message} ${AMBIGUOUS_HINT}` : e.message, ambiguous: e.ambiguous, at };
  }
  // Nieznany błąd traktujemy jak niejednoznaczny - bezpieczniej nie ponawiać.
  const msg = e instanceof Error ? e.message : String(e);
  return { code: 'internal_error', message: `${msg} ${AMBIGUOUS_HINT}`, ambiguous: true, at };
}
