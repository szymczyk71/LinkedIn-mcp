import type { NewPost } from './db/store.js';
import { LINK_PLACEHOLDER, type CommentStatus, type Post, type PlannedPost } from './model.js';
import { newId } from './util.js';

export function initialCommentStatus(p: Pick<PlannedPost, 'commentText' | 'linkMode'>): CommentStatus {
  if (!p.commentText.trim()) return 'none';
  return p.linkMode === 'later' ? 'waiting_link' : 'waiting';
}

/** Tworzy wiersz posta z pozycji zatwierdzanego planu. */
export function newPostFromPlanned(p: PlannedPost, seriesId: string): NewPost {
  return {
    ...p,
    id: newId('post'),
    seriesId,
    status: 'scheduled',
    commentUrl: null,
    commentStatus: initialCommentStatus(p),
    commentDueUtc: null,
    commentClaimedAt: null,
    idempotencyKey: newId('idem'),
    linkedinPostUrn: null,
    postUrl: null,
    linkedinCommentUrn: null,
    publishedAtUtc: null,
    lastError: null,
    commentError: null,
  };
}

export type CommentDecision = { action: 'post'; text: string; usedFallback: boolean } | { action: 'skip'; reason: string };

/** Ustala, jaki komentarz dodać w chwili jego terminu (tryb "later" i if_no_link). */
export function decideComment(post: Post): CommentDecision {
  if (post.linkMode !== 'later') return { action: 'post', text: post.commentText, usedFallback: false };
  if (post.commentUrl) return { action: 'post', text: post.commentText.split(LINK_PLACEHOLDER).join(post.commentUrl), usedFallback: false };
  if (post.ifNoLink === 'post_without_link' && post.commentTextNoLink?.trim()) {
    return { action: 'post', text: post.commentTextNoLink, usedFallback: true };
  }
  return { action: 'skip', reason: 'Link nie został podany na czas, a if_no_link = skip (lub brak wersji bez linku).' };
}
