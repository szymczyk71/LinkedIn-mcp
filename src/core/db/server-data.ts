/**
 * Dane potrzebne tylko w wariancie server-http (PostgreSQL): serwer OAuth dla konektora Claude,
 * przesyłanie zdjęć przez jednorazowe linki, zaszyfrowane sekrety i ustawienia (bezpiecznik, właściciel).
 * Tokeny, kody i identyfikatory biletów zapisujemy wyłącznie jako skróty SHA-256.
 */

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName: string | null;
  createdAt: string;
}

/** Oczekujące żądanie /authorize (czeka na powrót z logowania LinkedIn). */
export interface OAuthRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState: string | null;
  scope: string | null;
  expiresAt: string;
}

export interface OAuthCode {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string | null;
  personUrn: string;
  expiresAt: string;
}

export interface OAuthToken {
  tokenHash: string;
  kind: 'access' | 'refresh';
  clientId: string;
  /** Rodzina tokenów z jednego logowania - przy wykryciu ponownego użycia odświeżania unieważniamy całą rodzinę. */
  familyId: string;
  scope: string | null;
  personUrn: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface StoredImage {
  sha256: string;
  mime: string;
  data: Buffer;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface UploadTicketRow {
  id: string;
  tokenHash: string;
  status: 'pending' | 'done';
  imageSha256: string | null;
  originalName: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface ServerData {
  // obrazy
  putImage(img: StoredImage): Promise<void>;
  getImage(sha256: string): Promise<StoredImage | null>;

  // przesyłanie zdjęć
  createUpload(t: UploadTicketRow): Promise<void>;
  getUpload(id: string): Promise<UploadTicketRow | null>;
  getUploadByTokenHash(tokenHash: string): Promise<UploadTicketRow | null>;
  /** Atomowo: pending -> done (tylko raz i tylko przed wygaśnięciem). */
  completeUpload(id: string, imageSha256: string, originalName: string, nowUtc: string): Promise<boolean>;

  // sekrety i ustawienia
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string, nowUtc: string): Promise<void>;
  deleteSecret(name: string): Promise<boolean>;
  getSetting(name: string): Promise<string | null>;
  setSetting(name: string, value: string | null, nowUtc: string): Promise<void>;

  // OAuth
  createClient(c: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  createAuthRequest(r: OAuthRequest): Promise<void>;
  /** Zwraca i usuwa żądanie (jednorazowe), jeśli nie wygasło. */
  takeAuthRequest(id: string, nowUtc: string): Promise<OAuthRequest | null>;
  createCode(c: OAuthCode): Promise<void>;
  /** Zwraca i usuwa kod (jednorazowy), jeśli nie wygasł. */
  takeCode(codeHash: string, nowUtc: string): Promise<OAuthCode | null>;
  createToken(t: OAuthToken): Promise<void>;
  getToken(tokenHash: string): Promise<OAuthToken | null>;
  /** Atomowo unieważnia token odświeżania; zwraca go, jeśli był ważny (rotacja). */
  consumeRefreshToken(tokenHash: string, nowUtc: string): Promise<OAuthToken | null>;
  revokeFamily(familyId: string, nowUtc: string): Promise<number>;
  /** Unieważnia wszystkie tokeny konektora (np. po zmianie właściciela). */
  revokeAllTokens(nowUtc: string): Promise<number>;
  deleteExpiredServerData(nowUtc: string): Promise<number>;
}
