import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT } from '../core/config.js';

export const SERVER_NAME = 'linkedin';

export interface ClaudeServerEntry {
  command: string;
  args: string[];
}

export function serverEntry(nodeExe = process.execPath, root = PACKAGE_ROOT): ClaudeServerEntry {
  return { command: nodeExe, args: [path.join(root, 'dist', 'mcp-stdio', 'index.js')] };
}

export function snippet(entry = serverEntry()): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
}

/**
 * Plik konfiguracji Claude Desktop na Windows:
 * - instalacja ze Sklepu / MSIX: %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json
 * - instalator klasyczny:        %APPDATA%\Claude\claude_desktop_config.json
 */
export function findClaudeConfigCandidates(): string[] {
  const out: string[] = [];
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const pkgs = path.join(local, 'Packages');
  try {
    for (const d of fs.readdirSync(pkgs)) {
      if (/^Claude_/i.test(d)) out.push(path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    }
  } catch {
    /* brak katalogu Packages */
  }
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  out.push(path.join(appData, 'Claude', 'claude_desktop_config.json'));
  return out;
}

/** Pierwszy istniejący plik; jeśli żaden nie istnieje - pierwszy kandydat (MSIX, jeśli jest). */
export function defaultClaudeConfigPath(): string {
  const c = findClaudeConfigCandidates();
  return c.find((p) => fs.existsSync(p)) ?? c[0]!;
}

/**
 * Dopisuje (lub podmienia) wpis serwera "linkedin", zachowując resztę pliku.
 * Przed zapisem robi kopię zapasową obok pliku.
 */
export function writeClaudeConfig(file: string, entry = serverEntry(), now = new Date()): { file: string; backup: string | null } {
  let data: Record<string, unknown> = {};
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      data = raw.trim() ? (JSON.parse(raw.replace(/^﻿/, '')) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`Plik ${file} nie jest poprawnym JSON - popraw go ręcznie, nic nie zmieniono.`);
    }
    backup = `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const servers = (data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {}) as Record<string, unknown>;
  data.mcpServers = { ...servers, [SERVER_NAME]: entry };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { file, backup };
}
