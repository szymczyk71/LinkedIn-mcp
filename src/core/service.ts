import { z } from 'zod';
import { PlanAlreadyCommittedError, PlanExpiredError, PlanNotFoundError, type PostPatch } from './db/store.js';
import type { CoreContext } from './index.js';
import {
  CANCELABLE_STATUSES,
  EDITABLE_STATUSES,
  IF_NO_LINK,
  LINK_MODES,
  LINK_PLACEHOLDER,
  POST_STATUSES,
  type Actor,
  type IfNoLink,
  type LinkMode,
  type Plan,
  type PlannedPost,
  type Post,
  type PostEvent,
} from './model.js';
import { readPause } from './pause.js';
import { initialCommentStatus, newPostFromPlanned } from './posts.js';
import { TimeInputError, formatLocal, minutesBetween, nextTickUtc, parseLocalDateTime, tickWindow } from './time.js';
import { charCount, newId, textHash } from './util.js';
import { isValidTimezone } from './config.js';
import { ImageError, stageImage, type PostImage } from './image.js';

/** Błąd narzędzia: czytelny opis + kod, bez sekretów. */
export class ToolError extends Error {
  override name = 'ToolError';
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

// ---------- Schematy wejścia (wspólne dla MCP i lokalnego API) ----------

const text = (max = 20_000) => z.string().max(max);

export const PreviewPostInput = z.object({
  text: text().describe('Treść posta dokładnie taka, jaka ma się ukazać.'),
  publish_at: z.string().describe('Termin publikacji w czasie lokalnym, ISO 8601 bez strefy, np. 2026-11-06T08:00:00.'),
  comment_text: text().optional().default('').describe('Komentarz pod postem. Pusty = brak komentarza.'),
  link_mode: z.enum(LINK_MODES).optional().default('none').describe('none albo later (komentarz zawiera [LINK], link poda użytkownik).'),
  comment_text_no_link: text().optional().describe('Zatwierdzona wersja komentarza bez linku (gdy link nie dotrze na czas).'),
  if_no_link: z.enum(IF_NO_LINK).optional().describe('post_without_link albo skip.'),
  comment_delay_min: z.number().int().min(0).max(1440).optional().describe('Opóźnienie komentarza w minutach (domyślnie 10).'),
  image_path: z
    .string()
    .max(1000)
    .optional()
    .describe('Opcjonalny obraz: pełna ścieżka do pliku JPG/PNG/GIF na dysku użytkownika, np. C:\\Users\\...\\grafika.png.'),
  image_alt: z.string().max(4000).optional().describe('Tekst alternatywny obrazu (dla czytników ekranu).'),
});

export const PreviewSeriesInput = z.object({
  timezone: z.string().optional().describe('Strefa czasowa IANA, domyślnie Europe/Warsaw.'),
  posts: z.array(PreviewPostInput).min(1).max(100),
});

export const CommitSeriesInput = z.object({ plan_id: z.string().min(1) });

export const ListQueueInput = z.object({
  status: z.enum(POST_STATUSES).optional(),
  series_id: z.string().optional(),
  from: z.string().optional().describe('Od (czas lokalny RRRR-MM-DD lub RRRR-MM-DDTGG:MM[:SS]).'),
  to: z.string().optional().describe('Do (czas lokalny RRRR-MM-DD lub RRRR-MM-DDTGG:MM[:SS]).'),
});

export const IdInput = z.object({ id: z.string().min(1) });

export const UpdatePostInput = z.object({
  id: z.string().min(1),
  text: text().optional(),
  publish_at: z.string().optional().describe('Nowy termin (czas lokalny, ISO 8601 bez strefy).'),
  timezone: z.string().optional().describe('Strefa dla publish_at; domyślnie strefa posta.'),
  comment_text: text().optional(),
  comment_text_no_link: text().optional(),
  if_no_link: z.enum(IF_NO_LINK).optional(),
  image_path: z.string().max(1000).optional().describe('Nowy obraz (pełna ścieżka JPG/PNG/GIF).'),
  image_alt: z.string().max(4000).optional().describe('Nowy tekst alternatywny obrazu.'),
  remove_image: z.boolean().optional().describe('true = usuń obraz z posta.'),
});

export const SetCommentLinkInput = z.object({ id: z.string().min(1), url: z.string().min(1).max(2000) });

export type PreviewSeriesArgs = z.input<typeof PreviewSeriesInput>;

// ---------- Serwis ----------

interface CheckedPost {
  errors: string[];
  warnings: string[];
}

export class LinkedInService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly actor: Actor = 'mcp',
  ) {}

  private get cfg() {
    return this.ctx.config;
  }
  private now(): Date {
    return this.ctx.clock.now();
  }
  private nowIso(): string {
    return this.now().toISOString();
  }

  // ----- linkedin_auth_status -----
  async authStatus() {
    const { linkedin, store, config } = this.ctx;
    const info = await linkedin.checkAuth();
    const meta = await store.getAuthMeta();
    if (info.connected) {
      await store.setAuthMeta({
        personUrn: info.personUrn,
        profileName: info.profileName,
        profileUrl: info.profileUrl,
        expiresAt: info.expiresAt,
        scopes: info.scopes,
        canComment: meta?.canComment ?? 'unknown',
        updatedAt: this.nowIso(),
      });
    }
    const daysLeft = info.expiresAt ? Math.floor((new Date(info.expiresAt).getTime() - this.now().getTime()) / 86_400_000) : null;
    const warnings: string[] = [];
    if (!info.connected) warnings.push('Brak połączenia z LinkedIn. Zaloguj się na stronie login_url.');
    if (daysLeft !== null && daysLeft <= 7) warnings.push(`Logowanie do LinkedIn wygasa za ${daysLeft} dni. Zaloguj się ponownie (login_url).`);
    if (info.connected && !info.canPost) warnings.push('Brak uprawnienia do publikacji (w_member_social).');
    const pause = readPause(config.paths.pauseFlagFile);
    if (pause.paused) warnings.push('Bezpiecznik PAUSE jest włączony: harmonogram niczego nie publikuje.');
    const failedRecently = (await store.listPosts({ status: 'failed', limit: 20 })).length;
    if (failedRecently) warnings.push(`W kolejce są posty z błędem publikacji (${failedRecently}). Sprawdź linkedin_list_queue ze statusem failed.`);
    const result = {
      connected: info.connected,
      profile_name: info.profileName,
      profile_url: info.profileUrl,
      expires_at: info.expiresAt,
      days_left: daysLeft,
      login_url: `http://${config.workerHost}:${config.workerPort}/oauth/start`,
      can_post: info.connected && info.canPost,
      can_comment: meta?.canComment ?? 'unknown',
      mode: config.mode,
      paused: pause.paused,
      warnings,
    };
    await this.ctx.audit.record(this.actor, 'linkedin_auth_status', 'ok', null, { connected: result.connected });
    return result;
  }

  // ----- linkedin_preview_series -----
  async previewSeries(rawArgs: unknown) {
    const args = parseArgs(PreviewSeriesInput, rawArgs);
    const tz = args.timezone ?? this.cfg.defaultTimezone;
    if (!isValidTimezone(tz)) throw new ToolError('invalid_timezone', `Nieznana strefa czasowa: ${tz}`);
    const nowIso = this.nowIso();
    const interval = this.cfg.schedulerIntervalMin;

    const planned: (PlannedPost | null)[] = [];
    const out = [];
    const seenHashes = new Map<string, number>();
    const seriesTicks = new Map<string, number[]>();

    for (const [i, p] of args.posts.entries()) {
      const seq = i + 1;
      const chk: CheckedPost = { errors: [], warnings: [] };
      const postText = normalizeText(p.text);
      const commentText = normalizeText(p.comment_text ?? '');
      const noLink = p.comment_text_no_link === undefined ? null : normalizeText(p.comment_text_no_link);
      const ifNoLink: IfNoLink | null = p.link_mode === 'later' ? (p.if_no_link ?? (noLink ? 'post_without_link' : null)) : null;

      const utc = this.checkPublishAt(p.publish_at, tz, nowIso, chk);
      this.checkTexts(chk, postText, commentText, p.link_mode, noLink, ifNoLink);
      if (p.link_mode !== 'later' && p.if_no_link) chk.warnings.push('if_no_link jest ignorowane, gdy link_mode = none.');

      let image: PostImage | null = null;
      if (p.image_path?.trim()) image = this.checkImage(p.image_path, p.image_alt ?? '', chk);
      else if (p.image_alt) chk.warnings.push('image_alt podano bez image_path - zignorowano.');

      const hash = textHash(postText);
      if (seenHashes.has(hash)) chk.errors.push(`Treść identyczna jak w poście nr ${seenHashes.get(hash)} tej serii.`);
      else seenHashes.set(hash, seq);
      await this.checkDuplicate(chk, hash);

      let effective: string | null = null;
      if (utc) {
        effective = nextTickUtc(utc, interval);
        if (effective !== utc) {
          chk.warnings.push(
            `Harmonogram działa co ${interval} min - post wyjdzie o ${formatLocal(effective, tz)} (termin nie wypada na pełnym przebiegu).`,
          );
        }
        await this.checkCollisions(chk, utc, undefined, seq, seriesTicks, tz);
      }

      out.push({
        number: seq,
        publish_at_local: utc ? formatLocal(utc, tz) : null,
        publish_at_utc: utc,
        publish_effective_local: effective ? formatLocal(effective, tz) : null,
        chars: charCount(postText),
        comment: commentText
          ? { chars: charCount(commentText), link_mode: p.link_mode, if_no_link: ifNoLink, delay_min: p.comment_delay_min ?? this.cfg.commentDelayDefaultMin }
          : null,
        image: image ? presentImage(image) : null,
        warnings: chk.warnings,
        errors: chk.errors,
      });

      planned.push(
        chk.errors.length === 0 && utc
          ? {
              seq,
              text: postText,
              textHash: hash,
              publishAtUtc: utc,
              timezone: tz,
              commentText,
              linkMode: p.link_mode,
              commentTextNoLink: p.link_mode === 'later' ? noLink : null,
              ifNoLink,
              commentDelayMin: p.comment_delay_min ?? this.cfg.commentDelayDefaultMin,
              image,
            }
          : null,
      );
    }

    const withImage = out.filter((p) => p.image).length;
    const errorsTotal = out.reduce((n, p) => n + p.errors.length, 0);
    const warningsTotal = out.reduce((n, p) => n + p.warnings.length, 0);
    let planId: string | null = null;
    if (errorsTotal === 0) {
      const plan: Plan = {
        id: newId('plan'),
        createdAt: nowIso,
        expiresAt: new Date(this.now().getTime() + this.cfg.planTtlMin * 60_000).toISOString(),
        posts: planned as PlannedPost[],
        committedSeriesId: null,
        committedAt: null,
      };
      await this.ctx.store.savePlan(plan);
      planId = plan.id;
    }
    const times = out.map((p) => p.publish_at_utc).filter((t): t is string => !!t).sort();
    const summary = {
      posts: out.length,
      with_comment: out.filter((p) => p.comment).length,
      with_image: withImage,
      errors: errorsTotal,
      warnings: warningsTotal,
      first_local: times[0] ? formatLocal(times[0], tz) : null,
      last_local: times.length ? formatLocal(times[times.length - 1]!, tz) : null,
      timezone: tz,
      ready_to_commit: planId !== null,
      message:
        planId !== null
          ? `Podgląd gotowy. Pokaż go użytkownikowi; po akceptacji wywołaj linkedin_commit_series z plan_id (ważny ${this.cfg.planTtlMin} min).`
          : 'Seria ma błędy - popraw je i wygeneruj podgląd ponownie. Nic nie zostało zapisane.',
    };
    await this.ctx.audit.record(this.actor, 'linkedin_preview_series', errorsTotal ? 'rejected' : 'ok', planId, {
      posts: out.length,
      errors: errorsTotal,
      warnings: warningsTotal,
    });
    return { plan_id: planId, expires_in_min: planId ? this.cfg.planTtlMin : null, posts: out, summary };
  }

  // ----- linkedin_commit_series -----
  async commitSeries(rawArgs: unknown) {
    const { plan_id } = parseArgs(CommitSeriesInput, rawArgs);
    const { store, audit } = this.ctx;
    const nowIso = this.nowIso();
    const plan = await store.getPlan(plan_id);
    if (!plan) {
      await audit.record(this.actor, 'linkedin_commit_series', 'rejected', plan_id, { reason: 'plan_not_found' });
      throw new ToolError('plan_not_found', 'Nie ma planu o tym identyfikatorze (mógł wygasnąć i zostać usunięty). Wygeneruj nowy podgląd.');
    }
    if (!plan.committedSeriesId && plan.expiresAt > nowIso) {
      // Ponowna kontrola: od podglądu mogło minąć do PLAN_TTL_MIN minut.
      const problems: string[] = [];
      for (const p of plan.posts) {
        if (minutesBetween(nowIso, p.publishAtUtc) < this.cfg.minLeadMin) {
          problems.push(`Post nr ${p.seq}: termin ${formatLocal(p.publishAtUtc, p.timezone)} jest bliżej niż ${this.cfg.minLeadMin} min.`);
        }
        if ((await store.findByTextHash(p.textHash)).length) problems.push(`Post nr ${p.seq}: identyczna treść jest już w kolejce lub została opublikowana.`);
      }
      if (problems.length) {
        await audit.record(this.actor, 'linkedin_commit_series', 'rejected', plan_id, { problems });
        throw new ToolError('plan_no_longer_valid', 'Plan nie spełnia już warunków. Wygeneruj nowy podgląd.', { problems });
      }
    }
    try {
      const { series, posts } = await store.commitPlan(plan_id, nowIso, (pl, sid) => pl.posts.map((p) => newPostFromPlanned(p, sid)), newId('ser'));
      await audit.record(this.actor, 'linkedin_commit_series', 'ok', series.id, { planId: plan_id, posts: posts.map((p) => p.id) });
      return {
        series_id: series.id,
        posts: posts.map((p) => ({
          id: p.id,
          number: p.seq,
          status: p.status,
          publish_at_local: formatLocal(p.publishAtUtc, p.timezone),
          publish_at_utc: p.publishAtUtc,
          comment_status: p.commentStatus,
        })),
      };
    } catch (e) {
      if (e instanceof PlanAlreadyCommittedError) {
        await audit.record(this.actor, 'linkedin_commit_series', 'rejected', plan_id, { reason: 'already_committed' });
        throw new ToolError('plan_already_committed', 'Ten plan został już zatwierdzony. Nie utworzono duplikatów.', { series_id: e.seriesId });
      }
      if (e instanceof PlanExpiredError) {
        await audit.record(this.actor, 'linkedin_commit_series', 'rejected', plan_id, { reason: 'expired' });
        throw new ToolError('plan_expired', `Plan wygasł (ważność ${this.cfg.planTtlMin} min). Wygeneruj nowy podgląd.`);
      }
      if (e instanceof PlanNotFoundError) throw new ToolError('plan_not_found', e.message);
      throw e;
    }
  }

  // ----- linkedin_list_queue -----
  async listQueue(rawArgs: unknown) {
    const args = parseArgs(ListQueueInput, rawArgs ?? {});
    const tz = this.cfg.defaultTimezone;
    const fromUtc = args.from ? this.boundary(args.from, tz, 'start') : undefined;
    const toUtc = args.to ? this.boundary(args.to, tz, 'end') : undefined;
    const posts = await this.ctx.store.listPosts({ status: args.status, seriesId: args.series_id, fromUtc, toUtc });
    await this.ctx.audit.record(this.actor, 'linkedin_list_queue', 'ok', null, { count: posts.length });
    return {
      count: posts.length,
      posts: posts.map((p) => ({
        id: p.id,
        series_id: p.seriesId,
        text_start: excerpt(p.text),
        publish_at_local: formatLocal(p.publishAtUtc, p.timezone),
        status: p.status,
        comment_status: p.commentStatus,
        post_url: p.postUrl,
        last_error: p.lastError,
      })),
    };
  }

  // ----- linkedin_get_post -----
  async getPost(rawArgs: unknown) {
    const { id } = parseArgs(IdInput, rawArgs);
    const post = await this.mustGet(id);
    const events = await this.ctx.store.getEvents(id);
    await this.ctx.audit.record(this.actor, 'linkedin_get_post', 'ok', id);
    return { ...presentPost(post), events: events.map(presentEvent) };
  }

  // ----- linkedin_update_post -----
  async updatePost(rawArgs: unknown) {
    const args = parseArgs(UpdatePostInput, rawArgs);
    const { store, audit } = this.ctx;
    const post = await this.mustGet(args.id);
    const nowIso = this.nowIso();
    const reject = async (code: string, message: string, details?: Record<string, unknown>) => {
      await audit.record(this.actor, 'linkedin_update_post', 'rejected', post.id, { code });
      return new ToolError(code, message, details);
    };

    if (!EDITABLE_STATUSES.includes(post.status)) {
      throw await reject('not_editable', `Post ma status "${post.status}" - edycja jest możliwa tylko dla scheduled i missed.`);
    }
    const fields = (
      ['text', 'publish_at', 'comment_text', 'comment_text_no_link', 'if_no_link', 'image_path', 'image_alt', 'remove_image'] as const
    ).filter((f) => args[f] !== undefined);
    if (fields.length === 0) throw await reject('nothing_to_update', 'Nie podano żadnego pola do zmiany.');
    if (post.status === 'scheduled' && minutesBetween(nowIso, post.publishAtUtc) < this.cfg.minLeadMin) {
      throw await reject('too_close_to_publish', `Do publikacji zostało mniej niż ${this.cfg.minLeadMin} min - zmiana nie jest już możliwa.`);
    }
    if (post.status === 'missed' && args.publish_at === undefined) {
      throw await reject('missed_requires_new_time', 'Post ma status missed - podaj nowy publish_at, żeby wrócił do harmonogramu.');
    }

    const chk: CheckedPost = { errors: [], warnings: [] };
    const patch: PostPatch = {};
    const tz = args.timezone ?? post.timezone;
    if (args.timezone !== undefined && !isValidTimezone(tz)) throw await reject('invalid_timezone', `Nieznana strefa czasowa: ${tz}`);

    if (args.publish_at !== undefined) {
      const utc = this.checkPublishAt(args.publish_at, tz, nowIso, chk);
      if (utc) {
        patch.publishAtUtc = utc;
        patch.timezone = tz;
        const eff = nextTickUtc(utc, this.cfg.schedulerIntervalMin);
        if (eff !== utc) chk.warnings.push(`Post wyjdzie o ${formatLocal(eff, tz)} (harmonogram co ${this.cfg.schedulerIntervalMin} min).`);
        await this.checkCollisions(chk, utc, post.id);
      }
    }
    const newText = args.text !== undefined ? normalizeText(args.text) : post.text;
    const newComment = args.comment_text !== undefined ? normalizeText(args.comment_text) : post.commentText;
    const newNoLink = args.comment_text_no_link !== undefined ? normalizeText(args.comment_text_no_link) : post.commentTextNoLink;
    const newIfNoLink = post.linkMode === 'later' ? (args.if_no_link ?? post.ifNoLink ?? (newNoLink ? 'post_without_link' : null)) : null;
    this.checkTexts(chk, newText, newComment, post.linkMode, newNoLink, newIfNoLink);
    if (args.text !== undefined) {
      patch.text = newText;
      patch.textHash = textHash(newText);
      await this.checkDuplicate(chk, patch.textHash, post.id);
    }
    if (args.comment_text !== undefined) {
      patch.commentText = newComment;
      const base = initialCommentStatus({ commentText: newComment, linkMode: post.linkMode });
      patch.commentStatus = base === 'waiting_link' && post.commentUrl ? 'waiting' : base;
    }
    if (args.comment_text_no_link !== undefined) patch.commentTextNoLink = newNoLink;
    if (post.linkMode === 'later' && newIfNoLink !== post.ifNoLink) patch.ifNoLink = newIfNoLink;
    if (post.linkMode !== 'later' && args.if_no_link) chk.warnings.push('if_no_link jest ignorowane, gdy link_mode = none.');

    if (args.remove_image && args.image_path) {
      chk.errors.push('Podaj albo image_path (nowy obraz), albo remove_image, nie oba naraz.');
    } else if (args.image_path !== undefined) {
      const img = this.checkImage(args.image_path, args.image_alt ?? post.image?.alt ?? '', chk);
      if (img) patch.image = img;
    } else if (args.remove_image) {
      patch.image = null;
    } else if (args.image_alt !== undefined) {
      if (!post.image) chk.errors.push('Post nie ma obrazu - image_alt można zmienić tylko razem z obrazem.');
      else patch.image = { ...post.image, alt: args.image_alt };
    }

    if (chk.errors.length) throw await reject('validation_failed', 'Zmiana nie przeszła walidacji.', { errors: chk.errors, warnings: chk.warnings });
    if (post.status === 'missed') patch.status = 'scheduled';

    const updated = await store.transitionPost(post.id, EDITABLE_STATUSES, patch, nowIso, post.version);
    if (!updated) throw await reject('conflict', 'Post zmienił się w międzyczasie (np. zaczęła się publikacja). Sprawdź go i spróbuj ponownie.');
    await store.addEvent(post.id, 'updated', { fields, fromStatus: post.status, toStatus: updated.status }, nowIso);
    await audit.record(this.actor, 'linkedin_update_post', 'ok', post.id, { fields });
    return { ...presentPost(updated), warnings: chk.warnings };
  }

  // ----- linkedin_cancel_post -----
  async cancelPost(rawArgs: unknown) {
    const { id } = parseArgs(IdInput, rawArgs);
    const { store, audit } = this.ctx;
    const post = await this.mustGet(id);
    if (!CANCELABLE_STATUSES.includes(post.status)) {
      await audit.record(this.actor, 'linkedin_cancel_post', 'rejected', id, { status: post.status });
      throw new ToolError('not_cancelable', `Nie można anulować posta ze statusem "${post.status}".`);
    }
    const nowIso = this.nowIso();
    const commentStatus = post.commentStatus === 'none' || post.commentStatus === 'done' ? post.commentStatus : 'skipped';
    const updated = await store.transitionPost(id, CANCELABLE_STATUSES, { status: 'canceled', commentStatus }, nowIso, post.version);
    if (!updated) throw new ToolError('conflict', 'Post zmienił się w międzyczasie (np. zaczęła się publikacja). Sprawdź jego status.');
    await store.addEvent(id, 'canceled', { fromStatus: post.status }, nowIso);
    await audit.record(this.actor, 'linkedin_cancel_post', 'ok', id, { fromStatus: post.status });
    return presentPost(updated);
  }

  // ----- linkedin_set_comment_link -----
  async setCommentLink(rawArgs: unknown) {
    const { id, url } = parseArgs(SetCommentLinkInput, rawArgs);
    const { store, audit } = this.ctx;
    const post = await this.mustGet(id);
    const reject = async (code: string, message: string) => {
      await audit.record(this.actor, 'linkedin_set_comment_link', 'rejected', id, { code });
      return new ToolError(code, message);
    };
    const clean = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(clean);
    } catch {
      throw await reject('invalid_url', 'To nie jest poprawny adres URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || /\s/.test(clean)) {
      throw await reject('invalid_url', 'Adres musi zaczynać się od http:// lub https:// i nie może zawierać spacji.');
    }
    if (post.linkMode !== 'later') throw await reject('not_link_later', 'Ten post nie ma komentarza w trybie later.');
    if (!['scheduled', 'missed', 'published'].includes(post.status)) {
      throw await reject('not_editable', `Post ma status "${post.status}" - link nie zostanie już użyty.`);
    }
    if (!['waiting_link', 'waiting'].includes(post.commentStatus) || post.commentClaimedAt) {
      throw await reject('comment_not_pending', `Komentarz ma status "${post.commentStatus}" - nie da się już podmienić linku.`);
    }
    const nowIso = this.nowIso();
    const updated = await store.transitionPost(id, [post.status], { commentUrl: clean, commentStatus: 'waiting' }, nowIso, post.version);
    if (!updated) throw await reject('conflict', 'Post zmienił się w międzyczasie. Spróbuj ponownie.');
    await store.addEvent(id, 'comment_link_set', { host: parsed.hostname }, nowIso);
    await audit.record(this.actor, 'linkedin_set_comment_link', 'ok', id, { host: parsed.hostname });
    return { ...presentPost(updated), comment_preview: updated.commentText.split(LINK_PLACEHOLDER).join(clean) };
  }

  // ---------- walidacje ----------

  private checkPublishAt(input: string, tz: string, nowIso: string, chk: CheckedPost): string | null {
    try {
      const { utc, warnings } = parseLocalDateTime(input, tz);
      chk.warnings.push(...warnings);
      if (minutesBetween(nowIso, utc) < this.cfg.minLeadMin) {
        chk.errors.push(`Termin ${input} jest za wcześnie - minimum ${this.cfg.minLeadMin} min od teraz (${formatLocal(nowIso, tz)}).`);
      }
      return utc;
    } catch (e) {
      if (e instanceof TimeInputError) {
        chk.errors.push(e.message);
        return null;
      }
      throw e;
    }
  }

  private checkTexts(chk: CheckedPost, postText: string, comment: string, linkMode: LinkMode, noLink: string | null, ifNoLink: IfNoLink | null) {
    if (!postText.trim()) chk.errors.push('Treść posta jest pusta.');
    const n = charCount(postText);
    if (n > this.cfg.postMaxChars) chk.errors.push(`Post ma ${n} znaków - limit to ${this.cfg.postMaxChars}.`);
    if (postText.includes(LINK_PLACEHOLDER)) chk.errors.push(`Symbol ${LINK_PLACEHOLDER} może być tylko w komentarzu, nie w treści posta.`);
    const commentLen = charCount(comment);
    if (commentLen > 1250) chk.errors.push(`Komentarz ma ${commentLen} znaków - limit to 1250.`);
    if (comment.includes(LINK_PLACEHOLDER) && linkMode !== 'later') chk.errors.push(`Komentarz zawiera ${LINK_PLACEHOLDER}, więc link_mode musi być later.`);
    if (linkMode === 'later') {
      if (!comment.trim()) chk.errors.push('link_mode = later wymaga komentarza z symbolem [LINK].');
      else if (!comment.includes(LINK_PLACEHOLDER)) chk.warnings.push(`link_mode = later, ale komentarz nie zawiera ${LINK_PLACEHOLDER} - link nie zostanie wstawiony.`);
      if (!(noLink && noLink.trim()) && ifNoLink !== 'skip') {
        chk.errors.push('link_mode = later wymaga comment_text_no_link albo if_no_link = skip.');
      }
      if (ifNoLink === 'post_without_link' && !(noLink && noLink.trim())) {
        chk.errors.push('if_no_link = post_without_link wymaga comment_text_no_link.');
      }
      if (noLink?.includes(LINK_PLACEHOLDER)) chk.errors.push(`comment_text_no_link nie może zawierać ${LINK_PLACEHOLDER}.`);
    }
  }

  private checkImage(imagePath: string, alt: string, chk: CheckedPost): PostImage | null {
    try {
      const img = stageImage(imagePath, this.cfg.paths.imagesDir, this.cfg.imageMaxBytes, normalizeText(alt).trim());
      if (!img.alt) chk.warnings.push('Obraz nie ma tekstu alternatywnego (image_alt) - warto go dodać dla czytników ekranu.');
      return img;
    } catch (e) {
      if (e instanceof ImageError) {
        chk.errors.push(e.message);
        return null;
      }
      throw e;
    }
  }

  private async checkDuplicate(chk: CheckedPost, hash: string, excludeId?: string) {
    const dups = await this.ctx.store.findByTextHash(hash, excludeId);
    if (dups.length) {
      const d = dups[0]!;
      chk.errors.push(`Identyczna treść jest już ${d.status === 'published' ? 'opublikowana' : 'w kolejce'} (post ${d.id}, status ${d.status}).`);
    }
  }

  private async checkCollisions(chk: CheckedPost, utc: string, excludeId?: string, seq?: number, seriesTicks?: Map<string, number[]>, tz?: string) {
    const interval = this.cfg.schedulerIntervalMin;
    const w = tickWindow(utc, interval);
    const others = await this.ctx.store.findInWindow(w.startExclusive, w.endInclusive, excludeId);
    for (const o of others) {
      chk.warnings.push(`Kolizja terminu z postem ${o.id} (${formatLocal(o.publishAtUtc, o.timezone)}) - wyjdą w tym samym przebiegu harmonogramu.`);
    }
    if (seriesTicks && seq !== undefined) {
      const key = w.endInclusive;
      const same = seriesTicks.get(key) ?? [];
      if (same.length) chk.warnings.push(`Kolizja terminu z postem nr ${same.join(', ')} tej serii (przebieg ${formatLocal(key, tz!)}).`);
      seriesTicks.set(key, [...same, seq]);
    }
  }

  private boundary(input: string, tz: string, side: 'start' | 'end'): string {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(input.trim());
    const value = dateOnly ? `${input.trim()}T${side === 'start' ? '00:00:00' : '23:59:59'}` : input;
    try {
      return parseLocalDateTime(value, tz).utc;
    } catch (e) {
      if (e instanceof TimeInputError) throw new ToolError(e.code, `Parametr ${side === 'start' ? 'from' : 'to'}: ${e.message}`);
      throw e;
    }
  }

  private async mustGet(id: string): Promise<Post> {
    const p = await this.ctx.store.getPost(id);
    if (!p) throw new ToolError('post_not_found', `Nie ma posta o identyfikatorze ${id}.`);
    return p;
  }
}

// ---------- prezentacja ----------

function normalizeText(s: string): string {
  return s.normalize('NFC').replace(/\r\n?/g, '\n');
}

function excerpt(s: string, n = 80): string {
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join('');
}

export function presentPost(p: Post) {
  return {
    id: p.id,
    series_id: p.seriesId,
    number: p.seq,
    status: p.status,
    text: p.text,
    chars: charCount(p.text),
    publish_at_local: formatLocal(p.publishAtUtc, p.timezone),
    publish_at_utc: p.publishAtUtc,
    timezone: p.timezone,
    comment_text: p.commentText,
    link_mode: p.linkMode,
    comment_text_no_link: p.commentTextNoLink,
    if_no_link: p.ifNoLink,
    comment_delay_min: p.commentDelayMin,
    image: p.image ? presentImage(p.image) : null,
    comment_url: p.commentUrl,
    comment_status: p.commentStatus,
    comment_due_local: p.commentDueUtc ? formatLocal(p.commentDueUtc, p.timezone) : null,
    post_url: p.postUrl,
    published_at_local: p.publishedAtUtc ? formatLocal(p.publishedAtUtc, p.timezone) : null,
    last_error: p.lastError,
    comment_error: p.commentError,
  };
}

function presentImage(img: PostImage) {
  return { file_name: img.originalName, mime: img.mime, bytes: img.bytes, width: img.width, height: img.height, alt: img.alt };
}

function presentEvent(e: PostEvent) {
  return { at: e.at, type: e.type, detail: e.detail };
}

function parseArgs<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ToolError(
      'invalid_arguments',
      'Niepoprawne parametry: ' + r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}
