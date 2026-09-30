/** Wspólne mapowanie wierszy bazy na model (SQLite i PostgreSQL mają te same nazwy kolumn). */
import type { Plan, Post, PostStatus } from '../model.js';
import type { PostPatch } from './store.js';

/** Mapowanie pól Post (camelCase) na kolumny. Pola JSON obsługiwane osobno. */
export const POST_COLUMNS: Record<keyof PostPatch, string> = {
  text: 'text',
  textHash: 'text_hash',
  publishAtUtc: 'publish_at_utc',
  timezone: 'timezone',
  status: 'status',
  commentText: 'comment_text',
  linkMode: 'link_mode',
  commentTextNoLink: 'comment_text_no_link',
  ifNoLink: 'if_no_link',
  commentDelayMin: 'comment_delay_min',
  image: 'image_json',
  commentUrl: 'comment_url',
  commentStatus: 'comment_status',
  commentDueUtc: 'comment_due_utc',
  commentClaimedAt: 'comment_claimed_at',
  linkedinPostUrn: 'linkedin_post_urn',
  postUrl: 'post_url',
  linkedinCommentUrn: 'linkedin_comment_urn',
  publishedAtUtc: 'published_at_utc',
  lastError: 'last_error_json',
  commentError: 'comment_error_json',
};
export const JSON_FIELDS = new Set<keyof PostPatch>(['lastError', 'commentError', 'image']);

export type Row = Record<string, unknown>;

export function parseJson<T>(v: unknown): T | null {
  return typeof v === 'string' ? (JSON.parse(v) as T) : null;
}

export function rowToPost(r: Row): Post {
  return {
    id: r.id as string,
    seriesId: r.series_id as string,
    seq: r.seq as number,
    text: r.text as string,
    textHash: r.text_hash as string,
    publishAtUtc: r.publish_at_utc as string,
    timezone: r.timezone as string,
    status: r.status as PostStatus,
    commentText: r.comment_text as string,
    linkMode: r.link_mode as Post['linkMode'],
    commentTextNoLink: (r.comment_text_no_link as string | null) ?? null,
    ifNoLink: (r.if_no_link as Post['ifNoLink']) ?? null,
    commentDelayMin: r.comment_delay_min as number,
    image: parseJson(r.image_json),
    mode: (r.mode as Post['mode']) ?? 'mock',
    commentUrl: (r.comment_url as string | null) ?? null,
    commentStatus: r.comment_status as Post['commentStatus'],
    commentDueUtc: (r.comment_due_utc as string | null) ?? null,
    commentClaimedAt: (r.comment_claimed_at as string | null) ?? null,
    idempotencyKey: r.idempotency_key as string,
    linkedinPostUrn: (r.linkedin_post_urn as string | null) ?? null,
    postUrl: (r.post_url as string | null) ?? null,
    linkedinCommentUrn: (r.linkedin_comment_urn as string | null) ?? null,
    publishedAtUtc: (r.published_at_utc as string | null) ?? null,
    lastError: parseJson(r.last_error_json),
    commentError: parseJson(r.comment_error_json),
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function rowToPlan(r: Row): Plan {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    posts: JSON.parse(r.posts_json as string),
    committedSeriesId: (r.committed_series_id as string | null) ?? null,
    committedAt: (r.committed_at as string | null) ?? null,
  };
}
