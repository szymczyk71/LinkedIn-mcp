import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Tokeny LinkedIn zaszyfrowane w spoczynku (AES-256-GCM) w pliku linkedin-tokens.enc w katalogu danych.
 * Klucz: zmienna LINKEDIN_MCP_ENC_KEY (base64, 32 bajty) albo Menedżer poświadczeń Windows
 * (usługa "linkedin-mcp", konto "token-encryption-key"), tworzony przy pierwszym zapisie.
 * Token nigdy nie trafia do logów, audytu ani odpowiedzi narzędzi.
 */

export interface TokenRecord {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  refreshTokenExpiresAt: string | null;
  scopes: string[];
  personUrn: string;
  profileName: string | null;
  obtainedAt: string;
  source: 'oauth' | 'import';
}

/** Dane tokenu bezpieczne do pokazania (bez samego tokenu). */
export interface TokenInfo {
  present: boolean;
  expiresAt: string | null;
  scopes: string[];
  personUrn: string | null;
  profileName: string | null;
  obtainedAt: string | null;
  source: TokenRecord['source'] | null;
}

export interface KeyProvider {
  getKey(create: boolean): Promise<Buffer | null>;
}

const KEYRING_SERVICE = 'linkedin-mcp';
const KEYRING_ACCOUNT = 'token-encryption-key';

export class EnvOrKeyringKeyProvider implements KeyProvider {
  constructor(private readonly envKey: string | undefined) {}

  async getKey(create: boolean): Promise<Buffer | null> {
    if (this.envKey) return Buffer.from(this.envKey, 'base64');
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry(KEYRING_SERVICE, KEYRING_ACCOUNT);
    const existing = await entry.getPassword();
    if (existing) return Buffer.from(existing, 'base64');
    if (!create) return null;
    const key = crypto.randomBytes(32);
    await entry.setPassword(key.toString('base64'));
    return key;
  }
}

export class StaticKeyProvider implements KeyProvider {
  constructor(private readonly key: Buffer) {}
  async getKey(): Promise<Buffer> {
    return this.key;
  }
}

interface EncryptedFile {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/** Miejsce przechowywania zaszyfrowanego tokenu: plik (tryb lokalny) albo baza (server-http). */
export interface SecretBackend {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<boolean>;
}

export class FileSecret implements SecretBackend {
  constructor(private readonly file: string) {}
  async read(): Promise<string | null> {
    return fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : null;
  }
  async write(value: string): Promise<void> {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, value, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  async clear(): Promise<boolean> {
    const existed = fs.existsSync(this.file);
    fs.rmSync(this.file, { force: true });
    return existed;
  }
}

export class TokenStore {
  private readonly backend: SecretBackend;

  /** `target` = ścieżka pliku (tryb lokalny) albo dowolny SecretBackend. */
  constructor(
    target: string | SecretBackend,
    private readonly keys: KeyProvider,
  ) {
    this.backend = typeof target === 'string' ? new FileSecret(target) : target;
  }

  async save(rec: TokenRecord): Promise<void> {
    const key = await this.keys.getKey(true);
    if (!key || key.length !== 32) throw new Error('Brak 32-bajtowego klucza szyfrowania tokenów.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(rec), 'utf8'), cipher.final()]);
    const out: EncryptedFile = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    await this.backend.write(JSON.stringify(out));
  }

  async load(): Promise<TokenRecord | null> {
    const raw = await this.backend.read();
    if (!raw) return null;
    const enc = JSON.parse(raw) as EncryptedFile;
    const key = await this.keys.getKey(false);
    if (!key) throw new Error('Nie znaleziono klucza szyfrowania tokenów (Menedżer poświadczeń / LINKEDIN_MCP_ENC_KEY). Zaloguj się ponownie.');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as TokenRecord;
    } catch {
      throw new Error('Nie udało się odszyfrować tokenów LinkedIn (inny klucz lub uszkodzony plik). Zaloguj się ponownie.');
    }
  }

  async info(): Promise<TokenInfo> {
    const r = await this.load().catch(() => null);
    return {
      present: Boolean(r),
      expiresAt: r?.expiresAt ?? null,
      scopes: r?.scopes ?? [],
      personUrn: r?.personUrn ?? null,
      profileName: r?.profileName ?? null,
      obtainedAt: r?.obtainedAt ?? null,
      source: r?.source ?? null,
    };
  }

  clear(): Promise<boolean> {
    return this.backend.clear();
  }
}
