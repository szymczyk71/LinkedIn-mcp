import fs from 'node:fs';

/**
 * Bezpiecznik: dopóki jest włączony, harmonogram niczego nie publikuje.
 * Tryb lokalny: plik flagi PAUSE w katalogu danych. server-http: wpis w bazie (komenda CLI z DATABASE_URL).
 */
export interface PauseInfo {
  paused: boolean;
  since: string | null;
  reason: string | null;
}

export interface PauseBackend {
  read(): Promise<PauseInfo>;
  set(reason: string | null, now?: Date): Promise<PauseInfo>;
  clear(): Promise<PauseInfo>;
}

export class FilePause implements PauseBackend {
  constructor(private readonly flagFile: string) {}
  async read(): Promise<PauseInfo> {
    return readPause(this.flagFile);
  }
  async set(reason: string | null, now = new Date()): Promise<PauseInfo> {
    return setPause(this.flagFile, reason, now);
  }
  async clear(): Promise<PauseInfo> {
    return clearPause(this.flagFile);
  }
}

export function readPause(flagFile: string): PauseInfo {
  if (!fs.existsSync(flagFile)) return { paused: false, since: null, reason: null };
  try {
    const data = JSON.parse(fs.readFileSync(flagFile, 'utf8')) as { since?: string; reason?: string };
    return { paused: true, since: data.since ?? null, reason: data.reason ?? null };
  } catch {
    // Dowolna zawartość (także pusty plik) oznacza pauzę.
    return { paused: true, since: null, reason: null };
  }
}

export function setPause(flagFile: string, reason: string | null, now: Date = new Date()): PauseInfo {
  const info = { since: now.toISOString(), reason };
  fs.writeFileSync(flagFile, JSON.stringify(info, null, 2), 'utf8');
  return { paused: true, ...info };
}

export function clearPause(flagFile: string): PauseInfo {
  fs.rmSync(flagFile, { force: true });
  return { paused: false, since: null, reason: null };
}
