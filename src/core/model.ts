/** Model danych zgodny z docs/mcp-tools-contract.md. Wszystkie czasy w bazie to ISO 8601 UTC (z "Z"). */
import type { PostImage } from './image.js';

export type { PostImage } from './image.js';

export const POST_STATUSES = ['scheduled', 'publishing', 'published', 'failed', 'canceled', 'missed'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const COMMENT_STATUSES = ['none', 'waiting', 'waiting_link', 'done', 'skipped', 'failed'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const LINK_MODES = ['none', 'later'] as const;
export type LinkMode = (typeof LINK_MODES)[number];

export const IF_NO_LINK = ['post_without_link', 'skip'] as const;
export type IfNoLink = (typeof IF_NO_LINK)[number];

/** Statusy, w których post można jeszcze edytować (kontrakt + polityka "missed"). */
export const EDITABLE_STATUSES: readonly PostStatus[] = ['scheduled', 'missed'];
/** Statusy, z których post można anulować. */
export const CANCELABLE_STATUSES: readonly PostStatus[] = ['scheduled', 'missed', 'failed'];

export const LINK_PLACEHOLDER = '[LINK]';

export interface PostError {
  code: string;
  message: string;
  /** true, gdy nie wiadomo, czy post powstał na LinkedIn (np. timeout po wysłaniu). */
  ambiguous?: boolean;
  at: string;
}

/** Post w postaci, w jakiej trafia do planu (po walidacji i normalizacji). */
export interface PlannedPost {
  seq: number;
  text: string;
  textHash: string;
  publishAtUtc: string;
  timezone: string;
  commentText: string;
  linkMode: LinkMode;
  commentTextNoLink: string | null;
  ifNoLink: IfNoLink | null;
  commentDelayMin: number;
  image: PostImage | null;
}

export interface Plan {
  id: string;
  createdAt: string;
  expiresAt: string;
  posts: PlannedPost[];
  committedSeriesId: string | null;
  committedAt: string | null;
}

export interface Series {
  id: string;
  planId: string;
  createdAt: string;
}

export interface Post {
  id: string;
  seriesId: string;
  seq: number;
  text: string;
  textHash: string;
  publishAtUtc: string;
  timezone: string;
  status: PostStatus;
  commentText: string;
  linkMode: LinkMode;
  commentTextNoLink: string | null;
  ifNoLink: IfNoLink | null;
  commentDelayMin: number;
  image: PostImage | null;
  commentUrl: string | null;
  commentStatus: CommentStatus;
  commentDueUtc: string | null;
  /** Ustawiane tuż przed wysłaniem komentarza; chroni przed dublowaniem po restarcie. */
  commentClaimedAt: string | null;
  idempotencyKey: string;
  linkedinPostUrn: string | null;
  postUrl: string | null;
  linkedinCommentUrn: string | null;
  publishedAtUtc: string | null;
  lastError: PostError | null;
  commentError: PostError | null;
  /** Rośnie przy każdej zmianie wiersza (optymistyczna współbieżność). */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PostEvent {
  id: number;
  postId: string;
  at: string;
  type: string;
  detail: Record<string, unknown> | null;
}

export type Actor = 'mcp' | 'scheduler' | 'cli' | 'oauth' | 'system';

export interface AuditEntry {
  at: string;
  actor: Actor;
  action: string;
  target: string | null;
  result: 'ok' | 'error' | 'rejected';
  detail: Record<string, unknown> | null;
}

export type CanComment = 'yes' | 'no' | 'unknown';

/** Metadane logowania do LinkedIn. Sam token przechowuje TokenStore (zaszyfrowany). */
export interface AuthMeta {
  personUrn: string | null;
  profileName: string | null;
  profileUrl: string | null;
  expiresAt: string | null;
  scopes: string[];
  canComment: CanComment;
  updatedAt: string;
}
