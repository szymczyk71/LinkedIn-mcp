import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { LinkedInMode } from '../config.js';
import type { AuditEntry, AuthMeta, Plan, Post, PostEvent, PostStatus, Series } from '../model.js';
import { JSON_FIELDS, POST_COLUMNS, parseJson, rowToPlan, rowToPost, type Row } from './rows.js';
import {
  PlanAlreadyCommittedError,
  PlanExpiredError,
  PlanNotFoundError,
  type NewPost,
  type PostFilter,
  type PostPatch,
  type Store,
} from './store.js';

const MIGRATIONS: string[] = [
  // 1: schemat początkowy
  `
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    posts_json TEXT NOT NULL,
    committed_series_id TEXT,
    committed_at TEXT
  );

  CREATE TABLE series (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL UNIQUE REFERENCES plans(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL REFERENCES series(id),
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    publish_at_utc TEXT NOT NULL,
    timezone TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('scheduled','publishing','published','failed','canceled','missed')),
    comment_text TEXT NOT NULL,
    link_mode TEXT NOT NULL CHECK (link_mode IN ('none','later')),
    comment_text_no_link TEXT,
    if_no_link TEXT CHECK (if_no_link IS NULL OR if_no_link IN ('post_without_link','skip')),
    comment_delay_min INTEGER NOT NULL,
    comment_url TEXT,
    comment_status TEXT NOT NULL CHECK (comment_status IN ('none','waiting','waiting_link','done','skipped','failed')),
    comment_due_utc TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    linkedin_post_urn TEXT,
    post_url TEXT,
    linkedin_comment_urn TEXT,
    published_at_utc TEXT,
    last_error_json TEXT,
    comment_error_json TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (series_id, seq)
  );
  CREATE INDEX idx_posts_status_publish ON posts(status, publish_at_utc);
  CREATE INDEX idx_posts_text_hash ON posts(text_hash);
  CREATE INDEX idx_posts_comment ON posts(status, comment_status, comment_due_utc);

  CREATE TABLE post_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL REFERENCES posts(id),
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    detail_json TEXT
  );
  CREATE INDEX idx_events_post ON post_events(post_id, id);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    result TEXT NOT NULL,
    detail_json TEXT
  );

  CREATE TABLE auth_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    person_urn TEXT,
    profile_name TEXT,
    profile_url TEXT,
    expires_at TEXT,
    scopes_json TEXT NOT NULL,
    can_comment TEXT NOT NULL CHECK (can_comment IN ('yes','no','unknown')),
    updated_at TEXT NOT NULL
  );
  `,
  // 2: znacznik rozpoczętego komentarza
  `
  ALTER TABLE posts ADD COLUMN comment_claimed_at TEXT;
  `,
  // 3: obraz w poście
  `
  ALTER TABLE posts ADD COLUMN image_json TEXT;
  `,
  // 4: tryb (mock/live) posta i osobne metadane logowania dla każdego trybu
  `
  ALTER TABLE posts ADD COLUMN mode TEXT NOT NULL DEFAULT 'mock' CHECK (mode IN ('mock','live'));
  CREATE TABLE auth_state (
    mode TEXT PRIMARY KEY CHECK (mode IN ('mock','live')),
    person_urn TEXT,
    profile_name TEXT,
    profile_url TEXT,
    expires_at TEXT,
    scopes_json TEXT NOT NULL,
    can_comment TEXT NOT NULL CHECK (can_comment IN ('yes','no','unknown')),
    updated_at TEXT NOT NULL
  );
  INSERT INTO auth_state (mode, person_urn, profile_name, profile_url, expires_at, scopes_json, can_comment, updated_at)
    SELECT 'mock', person_urn, profile_name, profile_url, expires_at, scopes_json, can_comment, updated_at FROM auth_meta;
  DROP TABLE auth_meta;
  `,
  // 5: autorstwo postów (wspólna kolejka zespołu)
  `
  ALTER TABLE posts ADD COLUMN created_by TEXT;
  ALTER TABLE posts ADD COLUMN created_by_name TEXT;
  ALTER TABLE posts ADD COLUMN updated_by TEXT;
  ALTER TABLE posts ADD COLUMN updated_by_name TEXT;
  ALTER TABLE posts ADD COLUMN published_by TEXT;
  `,
];

export class SqliteStore implements Store {
  private readonly db: Database.Database;

  /** `file` = ścieżka pliku albo ':memory:'. */
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  async savePlan(plan: Plan): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO plans (id, created_at, expires_at, posts_json, committed_series_id, committed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(plan.id, plan.createdAt, plan.expiresAt, JSON.stringify(plan.posts), plan.committedSeriesId, plan.committedAt);
  }

  async getPlan(id: string): Promise<Plan | null> {
    const r = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToPlan(r) : null;
  }

  async commitPlan(
    planId: string,
    nowUtc: string,
    build: (plan: Plan, seriesId: string) => NewPost[],
    seriesId: string,
  ): Promise<{ series: Series; posts: Post[] }> {
    const run = this.db.transaction(() => {
      const r = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as Row | undefined;
      if (!r) throw new PlanNotFoundError(`Plan ${planId} nie istnieje.`);
      const plan = rowToPlan(r);
      if (plan.committedSeriesId) {
        throw new PlanAlreadyCommittedError(`Plan ${planId} został już zatwierdzony.`, plan.committedSeriesId);
      }
      if (plan.expiresAt <= nowUtc) throw new PlanExpiredError(`Plan ${planId} wygasł ${plan.expiresAt}.`);

      // Warunek w UPDATE chroni przed równoległym zatwierdzeniem z innego połączenia.
      const upd = this.db
        .prepare('UPDATE plans SET committed_series_id = ?, committed_at = ? WHERE id = ? AND committed_series_id IS NULL')
        .run(seriesId, nowUtc, planId);
      if (upd.changes !== 1) throw new PlanAlreadyCommittedError(`Plan ${planId} został już zatwierdzony.`, seriesId);

      this.db.prepare('INSERT INTO series (id, plan_id, created_at) VALUES (?, ?, ?)').run(seriesId, planId, nowUtc);
      const insert = this.db.prepare(
        `INSERT INTO posts (id, series_id, seq, text, text_hash, publish_at_utc, timezone, status, comment_text, link_mode,
           comment_text_no_link, if_no_link, comment_delay_min, image_json, mode, created_by, created_by_name, comment_url, comment_status, comment_due_utc, comment_claimed_at, idempotency_key,
           linkedin_post_urn, post_url, linkedin_comment_urn, published_at_utc, last_error_json, comment_error_json,
           version, created_at, updated_at)
         VALUES (@id, @seriesId, @seq, @text, @textHash, @publishAtUtc, @timezone, @status, @commentText, @linkMode,
           @commentTextNoLink, @ifNoLink, @commentDelayMin, @image, @mode, @createdBy, @createdByName, @commentUrl, @commentStatus, @commentDueUtc, @commentClaimedAt, @idempotencyKey,
           @linkedinPostUrn, @postUrl, @linkedinCommentUrn, @publishedAtUtc, @lastError, @commentError,
           1, @now, @now)`,
      );
      const newPosts = build(plan, seriesId);
      for (const p of newPosts) {
        insert.run({
          ...p,
          lastError: p.lastError ? JSON.stringify(p.lastError) : null,
          commentError: p.commentError ? JSON.stringify(p.commentError) : null,
          image: p.image ? JSON.stringify(p.image) : null,
          now: nowUtc,
        });
        this.db
          .prepare('INSERT INTO post_events (post_id, at, type, detail_json) VALUES (?, ?, ?, ?)')
          .run(p.id, nowUtc, 'created', JSON.stringify({ planId, seriesId, status: p.status }));
      }
      const posts = (this.db.prepare('SELECT * FROM posts WHERE series_id = ? ORDER BY seq').all(seriesId) as Row[]).map(rowToPost);
      return { series: { id: seriesId, planId, createdAt: nowUtc }, posts };
    });
    return run.immediate();
  }

  async deleteExpiredPlans(nowUtc: string): Promise<number> {
    return this.db.prepare('DELETE FROM plans WHERE committed_series_id IS NULL AND expires_at <= ?').run(nowUtc).changes;
  }

  async getSeries(id: string): Promise<Series | null> {
    const r = this.db.prepare('SELECT * FROM series WHERE id = ?').get(id) as Row | undefined;
    return r ? { id: r.id as string, planId: r.plan_id as string, createdAt: r.created_at as string } : null;
  }

  async getPost(id: string): Promise<Post | null> {
    const r = this.db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToPost(r) : null;
  }

  async listPosts(filter: PostFilter = {}): Promise<Post[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status !== undefined) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    if (filter.seriesId) {
      where.push('series_id = ?');
      args.push(filter.seriesId);
    }
    if (filter.fromUtc) {
      where.push('publish_at_utc >= ?');
      args.push(filter.fromUtc);
    }
    if (filter.toUtc) {
      where.push('publish_at_utc <= ?');
      args.push(filter.toUtc);
    }
    const sql = `SELECT * FROM posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY publish_at_utc, seq LIMIT ?`;
    args.push(filter.limit ?? 500);
    return (this.db.prepare(sql).all(...args) as Row[]).map(rowToPost);
  }

  async transitionPost(
    id: string,
    fromStatuses: readonly PostStatus[],
    patch: PostPatch,
    nowUtc: string,
    expectedVersion?: number,
  ): Promise<Post | null> {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof PostPatch, unknown][]) {
      if (value === undefined) continue;
      const col = POST_COLUMNS[key];
      if (!col) throw new Error(`Nieznane pole posta: ${String(key)}`);
      sets.push(`${col} = ?`);
      args.push(JSON_FIELDS.has(key) ? (value === null ? null : JSON.stringify(value)) : value);
    }
    sets.push('version = version + 1', 'updated_at = ?');
    args.push(nowUtc);

    let sql = `UPDATE posts SET ${sets.join(', ')} WHERE id = ? AND status IN (${fromStatuses.map(() => '?').join(',')})`;
    args.push(id, ...fromStatuses);
    if (expectedVersion !== undefined) {
      sql += ' AND version = ?';
      args.push(expectedVersion);
    }
    const res = this.db.prepare(sql).run(...args);
    if (res.changes !== 1) return null;
    return this.getPost(id);
  }

  async findDuePosts(nowUtc: string): Promise<Post[]> {
    return (
      this.db
        .prepare(`SELECT * FROM posts WHERE status = 'scheduled' AND publish_at_utc <= ? ORDER BY publish_at_utc, seq`)
        .all(nowUtc) as Row[]
    ).map(rowToPost);
  }

  async findDueComments(nowUtc: string): Promise<Post[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM posts WHERE status = 'published' AND comment_status IN ('waiting','waiting_link')
           AND comment_claimed_at IS NULL AND comment_due_utc IS NOT NULL AND comment_due_utc <= ?
           ORDER BY comment_due_utc`,
        )
        .all(nowUtc) as Row[]
    ).map(rowToPost);
  }

  async findByTextHash(hash: string, excludeId?: string): Promise<Post[]> {
    return (
      this.db
        .prepare(`SELECT * FROM posts WHERE text_hash = ? AND status <> 'canceled' AND id <> ?`)
        .all(hash, excludeId ?? '') as Row[]
    ).map(rowToPost);
  }

  async findInWindow(startExclusive: string, endInclusive: string, excludeId?: string): Promise<Post[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM posts WHERE status IN ('scheduled','publishing','missed')
           AND publish_at_utc > ? AND publish_at_utc <= ? AND id <> ? ORDER BY publish_at_utc`,
        )
        .all(startExclusive, endInclusive, excludeId ?? '') as Row[]
    ).map(rowToPost);
  }

  async findClaimedComments(): Promise<Post[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM posts WHERE status = 'published' AND comment_status IN ('waiting','waiting_link')
           AND comment_claimed_at IS NOT NULL`,
        )
        .all() as Row[]
    ).map(rowToPost);
  }

  async addEvent(postId: string, type: string, detail: Record<string, unknown> | null, atUtc: string): Promise<void> {
    this.db
      .prepare('INSERT INTO post_events (post_id, at, type, detail_json) VALUES (?, ?, ?, ?)')
      .run(postId, atUtc, type, detail ? JSON.stringify(detail) : null);
  }

  async getEvents(postId: string): Promise<PostEvent[]> {
    return (this.db.prepare('SELECT * FROM post_events WHERE post_id = ? ORDER BY id').all(postId) as Row[]).map((r) => ({
      id: r.id as number,
      postId: r.post_id as string,
      at: r.at as string,
      type: r.type as string,
      detail: parseJson(r.detail_json),
    }));
  }

  async appendAudit(e: AuditEntry): Promise<void> {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, action, target, result, detail_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.at, e.actor, e.action, e.target, e.result, e.detail ? JSON.stringify(e.detail) : null);
  }

  async listAudit(limit = 100): Promise<AuditEntry[]> {
    return (this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      at: r.at as string,
      actor: r.actor as AuditEntry['actor'],
      action: r.action as string,
      target: (r.target as string | null) ?? null,
      result: r.result as AuditEntry['result'],
      detail: parseJson(r.detail_json),
    }));
  }

  async getAuthMeta(mode: LinkedInMode): Promise<AuthMeta | null> {
    const r = this.db.prepare('SELECT * FROM auth_state WHERE mode = ?').get(mode) as Row | undefined;
    if (!r) return null;
    return {
      personUrn: (r.person_urn as string | null) ?? null,
      profileName: (r.profile_name as string | null) ?? null,
      profileUrl: (r.profile_url as string | null) ?? null,
      expiresAt: (r.expires_at as string | null) ?? null,
      scopes: JSON.parse(r.scopes_json as string),
      canComment: r.can_comment as AuthMeta['canComment'],
      updatedAt: r.updated_at as string,
    };
  }

  async setAuthMeta(mode: LinkedInMode, meta: AuthMeta | null): Promise<void> {
    if (meta === null) {
      this.db.prepare('DELETE FROM auth_state WHERE mode = ?').run(mode);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO auth_state (mode, person_urn, profile_name, profile_url, expires_at, scopes_json, can_comment, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mode) DO UPDATE SET person_urn = excluded.person_urn, profile_name = excluded.profile_name,
           profile_url = excluded.profile_url, expires_at = excluded.expires_at, scopes_json = excluded.scopes_json,
           can_comment = excluded.can_comment, updated_at = excluded.updated_at`,
      )
      .run(mode, meta.personUrn, meta.profileName, meta.profileUrl, meta.expiresAt, JSON.stringify(meta.scopes), meta.canComment, meta.updatedAt);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
