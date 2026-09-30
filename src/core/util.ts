import crypto from 'node:crypto';

/** Zegar wstrzykiwany, żeby testy mogły sterować czasem. */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(d: Date | string): void {
    this.t = new Date(d).getTime();
  }
  advanceMin(min: number): void {
    this.t += min * 60_000;
  }
}

export const toIso = (d: Date): string => d.toISOString();
export const addMinutes = (iso: string, min: number): string => new Date(new Date(iso).getTime() + min * 60_000).toISOString();

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

/** Normalizacja do wykrywania duplikatów: NFC, ujednolicone końce linii i białe znaki. */
export function normalizeForHash(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\s+$/gm, '').trim().toLowerCase();
}

export function textHash(text: string): string {
  return crypto.createHash('sha256').update(normalizeForHash(text)).digest('hex');
}

/** Liczba znaków tak, jak liczy ją człowiek (punkty kodowe, nie jednostki UTF-16). */
export function charCount(text: string): number {
  return [...text].length;
}

const SECRET_KEY = /(token|secret|authorization|password|passwd|cookie|code_verifier|client_secret|^code$|api[_-]?key|enc[_-]?key)/i;
const BEARER = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const LONG_OPAQUE = /\b[A-Za-z0-9\-_]{60,}\b/g;

/** Usuwa sekrety z obiektów przed zapisaniem do logu / odpowiedzi. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return '[depth]' as T;
  if (typeof value === 'string') {
    return value.replace(BEARER, 'Bearer [REDACTED]').replace(LONG_OPAQUE, '[REDACTED]') as T;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) } as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
