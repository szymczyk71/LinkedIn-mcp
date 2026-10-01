import type { TokenRecord, TokenStore } from './token-store.js';

/**
 * Konta LinkedIn osób, które mogą publikować w imieniu strony firmy (administratorzy strony).
 * Wersja lokalna: jedno konto (zaszyfrowany plik). server-http: tabela org_users + osobny zaszyfrowany token każdej osoby.
 * Post firmowy może opublikować dowolny aktywny administrator - preferujemy autora posta, a gdy jego logowanie
 * wygasło, używamy tokenu innej osoby (komentarze: najlepiej rola ADMINISTRATOR).
 */

export type AccountStatus = 'active' | 'revoked' | 'blocked';

export interface AccountInfo {
  personUrn: string;
  name: string | null;
  roles: string[];
  status: AccountStatus;
  tokenPresent: boolean;
  expiresAt: string | null;
  lastLoginAt: string | null;
  lastVerifiedAt: string | null;
}

export interface PickOptions {
  /** Najpierw spróbuj tej osoby (np. autora posta). */
  prefer?: string | null;
  /** Przy wyborze innej osoby preferuj te role (np. ADMINISTRATOR dla komentarzy jako strona). */
  preferRoles?: string[];
}

export interface Accounts {
  /** Zapis po zalogowaniu: token i dane osoby; konto staje się aktywne. */
  saveLogin(rec: TokenRecord, nowUtc: string): Promise<void>;
  get(personUrn: string): Promise<TokenRecord | null>;
  info(personUrn: string): Promise<AccountInfo | null>;
  list(): Promise<AccountInfo[]>;
  /** Ważny token aktywnej osoby do publikacji albo null, gdy nikt nie ma ważnego logowania. */
  pick(opts: PickOptions, nowUtc: string): Promise<TokenRecord | null>;
  /** Wynik ponownego sprawdzenia ról w LinkedIn (aktywny z nowymi rolami albo utrata dostępu). */
  setVerified(personUrn: string, status: AccountStatus, roles: string[] | null, nowUtc: string): Promise<void>;
  /** Usunięcie konta i tokenu. */
  remove(personUrn: string): Promise<boolean>;
}

const valid = (r: TokenRecord | null, nowUtc: string): r is TokenRecord => Boolean(r && r.expiresAt > nowUtc);

/** Wybór tokenu z listy kandydatów zgodnie z PickOptions. */
export async function pickFrom(
  accounts: AccountInfo[],
  load: (urn: string) => Promise<TokenRecord | null>,
  opts: PickOptions,
  nowUtc: string,
): Promise<TokenRecord | null> {
  const active = accounts.filter((a) => a.status === 'active' && a.tokenPresent && (!a.expiresAt || a.expiresAt > nowUtc));
  // Kolejność: najpierw wymagana rola (np. ADMINISTRATOR dla komentarzy jako strona), potem autor posta,
  // na końcu najdłużej ważne logowanie.
  const order = [...active].sort((a, b) => {
    const score = (x: AccountInfo) =>
      (opts.preferRoles?.length && !opts.preferRoles.some((r) => x.roles.includes(r)) ? 100 : 0) + (x.personUrn === opts.prefer ? 0 : 10);
    return score(a) - score(b) || (b.expiresAt ?? '').localeCompare(a.expiresAt ?? '');
  });
  for (const a of order) {
    const rec = await load(a.personUrn).catch(() => null);
    if (valid(rec, nowUtc)) return rec;
  }
  return null;
}

/** Wersja lokalna: jedno konto w zaszyfrowanym pliku. */
export class SingleAccount implements Accounts {
  constructor(private readonly tokens: TokenStore) {}

  async saveLogin(rec: TokenRecord): Promise<void> {
    await this.tokens.save(rec);
  }
  async get(personUrn: string): Promise<TokenRecord | null> {
    const r = await this.tokens.load().catch(() => null);
    return r && r.personUrn === personUrn ? r : null;
  }
  async info(personUrn: string): Promise<AccountInfo | null> {
    return (await this.list()).find((a) => a.personUrn === personUrn) ?? null;
  }
  async list(): Promise<AccountInfo[]> {
    const r = await this.tokens.load().catch(() => null);
    if (!r) return [];
    return [
      {
        personUrn: r.personUrn,
        name: r.profileName,
        roles: r.roles ?? [],
        status: 'active',
        tokenPresent: true,
        expiresAt: r.expiresAt,
        lastLoginAt: r.obtainedAt,
        lastVerifiedAt: r.obtainedAt,
      },
    ];
  }
  async pick(opts: PickOptions, nowUtc: string): Promise<TokenRecord | null> {
    return pickFrom(await this.list(), (u) => this.get(u), opts, nowUtc);
  }
  async setVerified(_personUrn: string, status: AccountStatus): Promise<void> {
    if (status !== 'active') await this.tokens.clear();
  }
  async remove(): Promise<boolean> {
    return this.tokens.clear();
  }
}
