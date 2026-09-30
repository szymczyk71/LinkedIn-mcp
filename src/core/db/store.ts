import type {
  AuditEntry,
  AuthMeta,
  Plan,
  Post,
  PostEvent,
  PostStatus,
  Series,
} from '../model.js';

export interface PostFilter {
  status?: PostStatus | PostStatus[];
  seriesId?: string;
  /** Włącznie, ISO UTC. */
  fromUtc?: string;
  /** Włącznie, ISO UTC. */
  toUtc?: string;
  limit?: number;
}

/** Pola posta, które można zmieniać po utworzeniu. */
export type PostPatch = Partial<
  Pick<
    Post,
    | 'text'
    | 'textHash'
    | 'publishAtUtc'
    | 'timezone'
    | 'status'
    | 'commentText'
    | 'linkMode'
    | 'commentTextNoLink'
    | 'ifNoLink'
    | 'commentDelayMin'
    | 'commentUrl'
    | 'commentStatus'
    | 'commentDueUtc'
    | 'commentClaimedAt'
    | 'linkedinPostUrn'
    | 'postUrl'
    | 'linkedinCommentUrn'
    | 'publishedAtUtc'
    | 'lastError'
    | 'commentError'
  >
>;

export type NewPost = Omit<Post, 'version' | 'createdAt' | 'updatedAt'>;

export class PlanNotFoundError extends Error {
  override name = 'PlanNotFoundError';
}
export class PlanExpiredError extends Error {
  override name = 'PlanExpiredError';
}
export class PlanAlreadyCommittedError extends Error {
  override name = 'PlanAlreadyCommittedError';
  constructor(
    message: string,
    readonly seriesId: string,
  ) {
    super(message);
  }
}

/**
 * Interfejs bazy. Asynchroniczny, żeby dało się podmienić SQLite na bazę sieciową
 * (np. Postgres w Azure) bez zmiany rdzenia.
 */
export interface Store {
  savePlan(plan: Plan): Promise<void>;
  getPlan(id: string): Promise<Plan | null>;
  /**
   * Atomowo zatwierdza plan: sprawdza ważność i brak wcześniejszego zatwierdzenia,
   * tworzy serię i posty. Drugie wywołanie dla tego samego planu rzuca PlanAlreadyCommittedError.
   */
  commitPlan(
    planId: string,
    nowUtc: string,
    build: (plan: Plan, seriesId: string) => NewPost[],
    seriesId: string,
  ): Promise<{ series: Series; posts: Post[] }>;
  deleteExpiredPlans(nowUtc: string): Promise<number>;

  getSeries(id: string): Promise<Series | null>;
  getPost(id: string): Promise<Post | null>;
  listPosts(filter?: PostFilter): Promise<Post[]>;

  /**
   * Zmiana warunkowa ("blokada wiersza"): zapisuje patch tylko, jeśli post ma jeden ze statusów
   * `fromStatuses` (i opcjonalnie wersję `expectedVersion`). Zwraca nowy stan albo null, gdy warunek
   * nie był spełniony - wtedy inny proces już przejął post albo jego stan się zmienił.
   */
  transitionPost(
    id: string,
    fromStatuses: readonly PostStatus[],
    patch: PostPatch,
    nowUtc: string,
    expectedVersion?: number,
  ): Promise<Post | null>;

  /** Posty ze statusem scheduled i terminem <= nowUtc, najstarsze pierwsze. */
  findDuePosts(nowUtc: string): Promise<Post[]>;
  /** Opublikowane posty, których komentarz czeka i ma termin <= nowUtc. */
  findDueComments(nowUtc: string): Promise<Post[]>;

  /** Czy istnieje post (poza anulowanymi) o tym hashu treści. */
  findByTextHash(hash: string, excludeId?: string): Promise<Post[]>;
  /** Aktywne posty (scheduled/publishing/missed) z terminem w oknie (startExclusive, endInclusive]. */
  findInWindow(startExclusive: string, endInclusive: string, excludeId?: string): Promise<Post[]>;
  /** Opublikowane posty, których komentarz został rozpoczęty (claim), ale nie zakończony. */
  findClaimedComments(): Promise<Post[]>;

  addEvent(postId: string, type: string, detail: Record<string, unknown> | null, atUtc: string): Promise<void>;
  getEvents(postId: string): Promise<PostEvent[]>;

  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(limit?: number): Promise<AuditEntry[]>;

  getAuthMeta(): Promise<AuthMeta | null>;
  setAuthMeta(meta: AuthMeta | null): Promise<void>;

  close(): Promise<void>;
}
