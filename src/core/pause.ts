import fs from 'node:fs';

/** Bezpiecznik: dopóki istnieje plik flagi PAUSE, harmonogram niczego nie publikuje. */
export interface PauseInfo {
  paused: boolean;
  since: string | null;
  reason: string | null;
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
