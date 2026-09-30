import pg from 'pg';
import type { LinkedInMode } from '../config.js';
import type { AuditEntry, AuthMeta, Plan, Post, PostEvent, PostStatus, Series } from '../model.js';
import { JSON_FIELDS, POST_COLUMNS, parseJson, rowToPlan, rowToPost, type Row } from './rows.js';
import type {
  OAuthClient,
  OAuthCode,
  OAuthRequest,
  OAuthToken,
  ServerData,
  StoredImage,
  UploadTicketRow,
} from './server-data.js';
import {
  PlanAlreadyCommittedError,
  PlanExpiredError,
  PlanNotFoundError,
  type NewPost,
  type PostFilter,
  type PostPatch,
  type Store,
} from './store.js';

/**
 * PostgreSQL (server-http, np. Azure Database for PostgreSQL). Czasy przechowujemy jako tekst ISO 8601 UTC,
 * tak jak w SQLite - porównania leksykalne są poprawne, a mapowanie wierszy jest wspólne (rows.ts).
 */

const MIGRATIONS: string[] = [
  // 1: pełny schemat (odpowiada migracjom 1-4 SQLite) + dane serwera
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
    image_json TEXT,
    mode TEXT NOT NULL DEFAULT 'mock' CHECK (mode IN ('mock','live')),
    comment_url TEXT,
    comment_status TEXT NOT NULL CHECK (comment_status IN ('none','waiting','waiting_link','done','skipped','failed')),
    comment_due_utc TEXT,
    comment_claimed_at TEXT,
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
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id),
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    detail_json TEXT
  );
  CREATE INDEX idx_events_post ON post_events(post_id, id);
  CREATE TABLE audit_log (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    result TEXT NOT NULL,
    detail_json TEXT
  );
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

  CREATE TABLE images (
    sha256 TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending','done')),
    image_sha256 TEXT REFERENCES images(sha256),
    original_name TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    redirect_uris_json TEXT NOT NULL,
    client_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE oauth_requests (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    client_state TEXT,
    scope TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT,
    person_urn TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    client_id TEXT NOT NULL,
    family_id TEXT NOT NULL,
    scope TEXT,
    person_urn TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_oauth_tokens_family ON oauth_tokens(family_id);
  `,
];

const MIGRATION_LOCK = 471_811;

export interface PgOptions {
  /** Schemat (search_path) - używany w testach do izolacji. */
  schema?: string;
  max?: number;
}

export class PostgresStore implements Store, ServerData {
  private constructor(private readonly pool: pg.Pool) {}

  static async connect(connectionString: string, opts: PgOptions = {}): Promise<PostgresStore> {
    const pool = new pg.Pool({
      connectionString,
      max: opts.max ?? 5,
      ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
    });
    pool.on('error', () => {
      /* błąd bezczynnego połączenia - pula nawiąże nowe */
    });
    const store = new PostgresStore(pool);
    if (opts.schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${ident(opts.schema)}`);
    await store.migrate();
    return store;
  }

  private async migrate(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
      await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      const { rows } = await c.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
      const current = Number(rows[0].v);
      for (let v = current; v < MIGRATIONS.length; v++) {
        await c.query('BEGIN');
        try {
          await c.query(MIGRATIONS[v]!);
          await c.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [v + 1, new Date().toISOString()]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
      c.release();
    }
  }

  private async q<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }

  // ---------- plany i posty ----------

  async savePlan(plan: Plan): Promise<void> {
    await this.q(
      `INSERT INTO plans (id, created_at, expires_at, posts_json, committed_series_id, committed_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [plan.id, plan.createdAt, plan.expiresAt, JSON.stringify(plan.posts), plan.committedSeriesId, plan.committedAt],
    );
  }

  async getPlan(id: string): Promise<Plan | null> {
    const [r] = await this.q('SELECT * FROM plans WHERE id = $1', [id]);
    return r ? rowToPlan(r) : null;
  }

  async commitPlan(
    planId: string,
    nowUtc: string,
    build: (plan: Plan, seriesId: string) => NewPost[],
    seriesId: string,
  ): Promise<{ series: Series; posts: Post[] }> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('SELECT * FROM plans WHERE id = $1 FOR UPDATE', [planId]);
      if (!rows[0]) throw new PlanNotFoundError(`Plan ${planId} nie istnieje.`);
      const plan = rowToPlan(rows[0]);
      if (plan.committedSeriesId) throw new PlanAlreadyCommittedError(`Plan ${planId} został już zatwierdzony.`, plan.committedSeriesId);
      if (plan.expiresAt <= nowUtc) throw new PlanExpiredError(`Plan ${planId} wygasł ${plan.expiresAt}.`);

      await c.query('UPDATE plans SET committed_series_id = $1, committed_at = $2 WHERE id = $3', [seriesId, nowUtc, planId]);
      await c.query('INSERT INTO series (id, plan_id, created_at) VALUES ($1,$2,$3)', [seriesId, planId, nowUtc]);
      for (const p of build(plan, seriesId)) {
        await c.query(
          `INSERT INTO posts (id, series_id, seq, text, text_hash, publish_at_utc, timezone, status, comment_text, link_mode,
             comment_text_no_link, if_no_link, comment_delay_min, image_json, mode, comment_url, comment_status, comment_due_utc,
             comment_claimed_at, idempotency_key, linkedin_post_urn, post_url, linkedin_comment_urn, published_at_utc,
             last_error_json, comment_error_json, version, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,1,$27,$27)`,
          [
            p.id, p.seriesId, p.seq, p.text, p.textHash, p.publishAtUtc, p.timezone, p.status, p.commentText, p.linkMode,
            p.commentTextNoLink, p.ifNoLink, p.commentDelayMin, p.image ? JSON.stringify(p.image) : null, p.mode, p.commentUrl,
            p.commentStatus, p.commentDueUtc, p.commentClaimedAt, p.idempotencyKey, p.linkedinPostUrn, p.postUrl,
            p.linkedinCommentUrn, p.publishedAtUtc, p.lastError ? JSON.stringify(p.lastError) : null,
            p.commentError ? JSON.stringify(p.commentError) : null, nowUtc,
          ],
        );
        await c.query('INSERT INTO post_events (post_id, at, type, detail_json) VALUES ($1,$2,$3,$4)', [
          p.id,
          nowUtc,
          'created',
          JSON.stringify({ planId, seriesId, status: p.status }),
        ]);
      }
      const posts = (await c.query('SELECT * FROM posts WHERE series_id = $1 ORDER BY seq', [seriesId])).rows.map(rowToPost);
      await c.query('COMMIT');
      return { series: { id: seriesId, planId, createdAt: nowUtc }, posts };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if ((e as { code?: string }).code === '23505') throw new PlanAlreadyCommittedError(`Plan ${planId} został już zatwierdzony.`, seriesId);
      throw e;
    } finally {
      c.release();
    }
  }

  async deleteExpiredPlans(nowUtc: string): Promise<number> {
    const r = await this.pool.query('DELETE FROM plans WHERE committed_series_id IS NULL AND expires_at <= $1', [nowUtc]);
    return r.rowCount ?? 0;
  }

  async getSeries(id: string): Promise<Series | null> {
    const [r] = await this.q('SELECT * FROM series WHERE id = $1', [id]);
    return r ? { id: r.id as string, planId: r.plan_id as string, createdAt: r.created_at as string } : null;
  }

  async getPost(id: string): Promise<Post | null> {
    const [r] = await this.q('SELECT * FROM posts WHERE id = $1', [id]);
    return r ? rowToPost(r) : null;
  }

  async listPosts(filter: PostFilter = {}): Promise<Post[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    const p = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };
    if (filter.status !== undefined) where.push(`status = ANY(${p(Array.isArray(filter.status) ? filter.status : [filter.status])})`);
    if (filter.seriesId) where.push(`series_id = ${p(filter.seriesId)}`);
    if (filter.fromUtc) where.push(`publish_at_utc >= ${p(filter.fromUtc)}`);
    if (filter.toUtc) where.push(`publish_at_utc <= ${p(filter.toUtc)}`);
    const sql = `SELECT * FROM posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY publish_at_utc, seq LIMIT ${p(filter.limit ?? 500)}`;
    return (await this.q(sql, args)).map(rowToPost);
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
    const p = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };
    for (const [key, value] of Object.entries(patch) as [keyof PostPatch, unknown][]) {
      if (value === undefined) continue;
      const col = POST_COLUMNS[key];
      if (!col) throw new Error(`Nieznane pole posta: ${String(key)}`);
      sets.push(`${col} = ${p(JSON_FIELDS.has(key) ? (value === null ? null : JSON.stringify(value)) : value)}`);
    }
    sets.push('version = version + 1', `updated_at = ${p(nowUtc)}`);
    let sql = `UPDATE posts SET ${sets.join(', ')} WHERE id = ${p(id)} AND status = ANY(${p([...fromStatuses])})`;
    if (expectedVersion !== undefined) sql += ` AND version = ${p(expectedVersion)}`;
    const rows = await this.q(`${sql} RETURNING *`, args);
    return rows[0] ? rowToPost(rows[0]) : null;
  }

  async findDuePosts(nowUtc: string): Promise<Post[]> {
    return (await this.q(`SELECT * FROM posts WHERE status = 'scheduled' AND publish_at_utc <= $1 ORDER BY publish_at_utc, seq`, [nowUtc])).map(rowToPost);
  }

  async findDueComments(nowUtc: string): Promise<Post[]> {
    return (
      await this.q(
        `SELECT * FROM posts WHERE status = 'published' AND comment_status IN ('waiting','waiting_link')
         AND comment_claimed_at IS NULL AND comment_due_utc IS NOT NULL AND comment_due_utc <= $1 ORDER BY comment_due_utc`,
        [nowUtc],
      )
    ).map(rowToPost);
  }

  async findByTextHash(hash: string, excludeId?: string): Promise<Post[]> {
    return (await this.q(`SELECT * FROM posts WHERE text_hash = $1 AND status <> 'canceled' AND id <> $2`, [hash, excludeId ?? ''])).map(rowToPost);
  }

  async findInWindow(startExclusive: string, endInclusive: string, excludeId?: string): Promise<Post[]> {
    return (
      await this.q(
        `SELECT * FROM posts WHERE status IN ('scheduled','publishing','missed') AND publish_at_utc > $1 AND publish_at_utc <= $2
         AND id <> $3 ORDER BY publish_at_utc`,
        [startExclusive, endInclusive, excludeId ?? ''],
      )
    ).map(rowToPost);
  }

  async findClaimedComments(): Promise<Post[]> {
    return (
      await this.q(
        `SELECT * FROM posts WHERE status = 'published' AND comment_status IN ('waiting','waiting_link') AND comment_claimed_at IS NOT NULL`,
      )
    ).map(rowToPost);
  }

  async addEvent(postId: string, type: string, detail: Record<string, unknown> | null, atUtc: string): Promise<void> {
    await this.q('INSERT INTO post_events (post_id, at, type, detail_json) VALUES ($1,$2,$3,$4)', [postId, atUtc, type, detail ? JSON.stringify(detail) : null]);
  }

  async getEvents(postId: string): Promise<PostEvent[]> {
    return (await this.q('SELECT * FROM post_events WHERE post_id = $1 ORDER BY id', [postId])).map((r) => ({
      id: Number(r.id),
      postId: r.post_id as string,
      at: r.at as string,
      type: r.type as string,
      detail: parseJson(r.detail_json),
    }));
  }

  async appendAudit(e: AuditEntry): Promise<void> {
    await this.q('INSERT INTO audit_log (at, actor, action, target, result, detail_json) VALUES ($1,$2,$3,$4,$5,$6)', [
      e.at,
      e.actor,
      e.action,
      e.target,
      e.result,
      e.detail ? JSON.stringify(e.detail) : null,
    ]);
  }

  async listAudit(limit = 100): Promise<AuditEntry[]> {
    return (await this.q('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit])).map((r) => ({
      at: r.at as string,
      actor: r.actor as AuditEntry['actor'],
      action: r.action as string,
      target: (r.target as string | null) ?? null,
      result: r.result as AuditEntry['result'],
      detail: parseJson(r.detail_json),
    }));
  }

  async getAuthMeta(mode: LinkedInMode): Promise<AuthMeta | null> {
    const [r] = await this.q('SELECT * FROM auth_state WHERE mode = $1', [mode]);
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
      await this.q('DELETE FROM auth_state WHERE mode = $1', [mode]);
      return;
    }
    await this.q(
      `INSERT INTO auth_state (mode, person_urn, profile_name, profile_url, expires_at, scopes_json, can_comment, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (mode) DO UPDATE SET person_urn = EXCLUDED.person_urn, profile_name = EXCLUDED.profile_name,
         profile_url = EXCLUDED.profile_url, expires_at = EXCLUDED.expires_at, scopes_json = EXCLUDED.scopes_json,
         can_comment = EXCLUDED.can_comment, updated_at = EXCLUDED.updated_at`,
      [mode, meta.personUrn, meta.profileName, meta.profileUrl, meta.expiresAt, JSON.stringify(meta.scopes), meta.canComment, meta.updatedAt],
    );
  }

  // ---------- obrazy i przesyłanie ----------

  async putImage(img: StoredImage): Promise<void> {
    await this.q(
      `INSERT INTO images (sha256, mime, data, width, height, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (sha256) DO NOTHING`,
      [img.sha256, img.mime, img.data, img.width, img.height, img.createdAt],
    );
  }

  async getImage(sha256: string): Promise<StoredImage | null> {
    const [r] = await this.q('SELECT * FROM images WHERE sha256 = $1', [sha256]);
    if (!r) return null;
    return {
      sha256: r.sha256 as string,
      mime: r.mime as string,
      data: r.data as Buffer,
      width: (r.width as number | null) ?? null,
      height: (r.height as number | null) ?? null,
      createdAt: r.created_at as string,
    };
  }

  async createUpload(t: UploadTicketRow): Promise<void> {
    await this.q(
      `INSERT INTO uploads (id, token_hash, status, image_sha256, original_name, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [t.id, t.tokenHash, t.status, t.imageSha256, t.originalName, t.createdAt, t.expiresAt],
    );
  }

  async getUpload(id: string): Promise<UploadTicketRow | null> {
    const [r] = await this.q('SELECT * FROM uploads WHERE id = $1', [id]);
    return r ? rowToUpload(r) : null;
  }

  async getUploadByTokenHash(tokenHash: string): Promise<UploadTicketRow | null> {
    const [r] = await this.q('SELECT * FROM uploads WHERE token_hash = $1', [tokenHash]);
    return r ? rowToUpload(r) : null;
  }

  async completeUpload(id: string, imageSha256: string, originalName: string, nowUtc: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE uploads SET status = 'done', image_sha256 = $2, original_name = $3 WHERE id = $1 AND status = 'pending' AND expires_at > $4`,
      [id, imageSha256, originalName, nowUtc],
    );
    return r.rowCount === 1;
  }

  // ---------- sekrety i ustawienia ----------

  async getSecret(name: string): Promise<string | null> {
    const [r] = await this.q('SELECT value FROM secrets WHERE name = $1', [name]);
    return (r?.value as string | undefined) ?? null;
  }

  async setSecret(name: string, value: string, nowUtc: string): Promise<void> {
    await this.q(
      `INSERT INTO secrets (name, value, updated_at) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [name, value, nowUtc],
    );
  }

  async deleteSecret(name: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM secrets WHERE name = $1', [name]);
    return (r.rowCount ?? 0) > 0;
  }

  async getSetting(name: string): Promise<string | null> {
    const [r] = await this.q('SELECT value FROM settings WHERE name = $1', [name]);
    return (r?.value as string | undefined) ?? null;
  }

  async setSetting(name: string, value: string | null, nowUtc: string): Promise<void> {
    if (value === null) {
      await this.q('DELETE FROM settings WHERE name = $1', [name]);
      return;
    }
    await this.q(
      `INSERT INTO settings (name, value, updated_at) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [name, value, nowUtc],
    );
  }

  // ---------- OAuth ----------

  async createClient(c: OAuthClient): Promise<void> {
    await this.q('INSERT INTO oauth_clients (client_id, redirect_uris_json, client_name, created_at) VALUES ($1,$2,$3,$4)', [
      c.clientId,
      JSON.stringify(c.redirectUris),
      c.clientName,
      c.createdAt,
    ]);
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const [r] = await this.q('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
    if (!r) return null;
    return { clientId: r.client_id as string, redirectUris: JSON.parse(r.redirect_uris_json as string), clientName: (r.client_name as string | null) ?? null, createdAt: r.created_at as string };
  }

  async createAuthRequest(r: OAuthRequest): Promise<void> {
    await this.q(
      'INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, client_state, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [r.id, r.clientId, r.redirectUri, r.codeChallenge, r.clientState, r.scope, r.expiresAt],
    );
  }

  async takeAuthRequest(id: string, nowUtc: string): Promise<OAuthRequest | null> {
    const [r] = await this.q('DELETE FROM oauth_requests WHERE id = $1 RETURNING *', [id]);
    if (!r || (r.expires_at as string) <= nowUtc) return null;
    return {
      id: r.id as string,
      clientId: r.client_id as string,
      redirectUri: r.redirect_uri as string,
      codeChallenge: r.code_challenge as string,
      clientState: (r.client_state as string | null) ?? null,
      scope: (r.scope as string | null) ?? null,
      expiresAt: r.expires_at as string,
    };
  }

  async createCode(c: OAuthCode): Promise<void> {
    await this.q(
      'INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, person_urn, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [c.codeHash, c.clientId, c.redirectUri, c.codeChallenge, c.scope, c.personUrn, c.expiresAt],
    );
  }

  async takeCode(codeHash: string, nowUtc: string): Promise<OAuthCode | null> {
    const [r] = await this.q('DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING *', [codeHash]);
    if (!r || (r.expires_at as string) <= nowUtc) return null;
    return {
      codeHash: r.code_hash as string,
      clientId: r.client_id as string,
      redirectUri: r.redirect_uri as string,
      codeChallenge: r.code_challenge as string,
      scope: (r.scope as string | null) ?? null,
      personUrn: r.person_urn as string,
      expiresAt: r.expires_at as string,
    };
  }

  async createToken(t: OAuthToken): Promise<void> {
    await this.q(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, family_id, scope, person_urn, expires_at, revoked_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [t.tokenHash, t.kind, t.clientId, t.familyId, t.scope, t.personUrn, t.expiresAt, t.revokedAt, t.createdAt],
    );
  }

  async getToken(tokenHash: string): Promise<OAuthToken | null> {
    const [r] = await this.q('SELECT * FROM oauth_tokens WHERE token_hash = $1', [tokenHash]);
    return r ? rowToToken(r) : null;
  }

  async consumeRefreshToken(tokenHash: string, nowUtc: string): Promise<OAuthToken | null> {
    const [r] = await this.q(
      `UPDATE oauth_tokens SET revoked_at = $2 WHERE token_hash = $1 AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > $2 RETURNING *`,
      [tokenHash, nowUtc],
    );
    return r ? rowToToken(r) : null;
  }

  async revokeFamily(familyId: string, nowUtc: string): Promise<number> {
    const r = await this.pool.query('UPDATE oauth_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL', [familyId, nowUtc]);
    return r.rowCount ?? 0;
  }

  async revokeAllTokens(nowUtc: string): Promise<number> {
    const r = await this.pool.query('UPDATE oauth_tokens SET revoked_at = $1 WHERE revoked_at IS NULL', [nowUtc]);
    return r.rowCount ?? 0;
  }

  async deleteExpiredServerData(nowUtc: string): Promise<number> {
    let n = 0;
    for (const sql of [
      'DELETE FROM oauth_requests WHERE expires_at <= $1',
      'DELETE FROM oauth_codes WHERE expires_at <= $1',
      'DELETE FROM oauth_tokens WHERE expires_at <= $1',
      `DELETE FROM uploads WHERE status = 'pending' AND expires_at <= $1`,
    ]) {
      n += (await this.pool.query(sql, [nowUtc])).rowCount ?? 0;
    }
    return n;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToUpload(r: Row): UploadTicketRow {
  return {
    id: r.id as string,
    tokenHash: r.token_hash as string,
    status: r.status as UploadTicketRow['status'],
    imageSha256: (r.image_sha256 as string | null) ?? null,
    originalName: (r.original_name as string | null) ?? null,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
  };
}

function rowToToken(r: Row): OAuthToken {
  return {
    tokenHash: r.token_hash as string,
    kind: r.kind as OAuthToken['kind'],
    clientId: r.client_id as string,
    familyId: r.family_id as string,
    scope: (r.scope as string | null) ?? null,
    personUrn: r.person_urn as string,
    expiresAt: r.expires_at as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Niepoprawna nazwa schematu: ${name}`);
  return `"${name}"`;
}
