/** Interfejs klienta LinkedIn. Implementacje: MockLinkedIn (atrapa) i LiveLinkedIn (etap 5). */

export interface AuthInfo {
  connected: boolean;
  personUrn: string | null;
  profileName: string | null;
  profileUrl: string | null;
  expiresAt: string | null;
  scopes: string[];
  canPost: boolean;
}

export interface PublishImage {
  /** Treść zatwierdzonej kopii (odczytana z magazynu obrazów). */
  data: Buffer;
  mime: string;
  sha256: string;
  bytes: number;
  alt: string;
}

export interface PublishInput {
  text: string;
  /** Opcjonalny obraz: klient najpierw go wysyła (upload), potem tworzy post z obrazem. */
  image?: PublishImage;
  /** Stały klucz posta w naszej bazie. Atrapa używa go do wykrywania duplikatów. */
  idempotencyKey: string;
}

export interface PublishResult {
  postUrn: string;
  postUrl: string;
}

export interface CommentInput {
  postUrn: string;
  text: string;
  idempotencyKey: string;
}

export interface CommentResult {
  commentUrn: string;
}

export interface LinkedInClient {
  readonly mode: 'mock' | 'live';
  checkAuth(): Promise<AuthInfo>;
  publishPost(input: PublishInput): Promise<PublishResult>;
  addComment(input: CommentInput): Promise<CommentResult>;
}

/**
 * Rodzaje błędów:
 * - rejected:     LinkedIn odrzucił żądanie, obiekt na pewno nie powstał
 * - unauthorized: brak lub nieważny token
 * - forbidden:    brak uprawnień (np. do komentowania)
 * - rate_limited: limit wywołań, obiekt nie powstał
 * - network:      błąd połączenia przed wysłaniem, obiekt nie powstał
 * - timeout:      brak odpowiedzi po wysłaniu - niejednoznaczne
 * - ambiguous:    inny błąd po wysłaniu (np. 5xx, zerwane połączenie) - niejednoznaczne
 */
export type LinkedInErrorKind = 'rejected' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'network' | 'timeout' | 'ambiguous';

const AMBIGUOUS_KINDS: ReadonlySet<LinkedInErrorKind> = new Set(['timeout', 'ambiguous']);

export class LinkedInError extends Error {
  override name = 'LinkedInError';
  readonly ambiguous: boolean;
  constructor(
    readonly kind: LinkedInErrorKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.ambiguous = AMBIGUOUS_KINDS.has(kind);
  }
  get code(): string {
    return `linkedin_${this.kind}`;
  }
}
