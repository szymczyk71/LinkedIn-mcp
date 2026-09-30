import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT } from '../core/config.js';

/**
 * Autostart przy logowaniu do Windows: skrypt .vbs w folderze Autostart użytkownika
 * (shell:startup). Nie wymaga uprawnień administratora i uruchamia worker bez okna konsoli.
 */
export const AUTOSTART_FILE_NAME = 'LinkedIn MCP Worker.vbs';

export function startupDir(): string {
  if (process.env.LINKEDIN_MCP_STARTUP_DIR) return process.env.LINKEDIN_MCP_STARTUP_DIR;
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function autostartFile(): string {
  return path.join(startupDir(), AUTOSTART_FILE_NAME);
}

const vbsQuote = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function buildVbs(nodeExe = process.execPath, root = PACKAGE_ROOT): string {
  const cli = path.join(root, 'dist', 'cli', 'index.js');
  // W VBS podwójny cudzysłów wewnątrz napisu zapisuje się jako "".
  const cmd = `"${nodeExe}" "${cli}" worker start`;
  return [
    "' Autostart workera LinkedIn MCP (utworzone przez: npm run autostart:install)",
    "' Usuwanie: npm run autostart:uninstall",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${vbsQuote(root)}`,
    `sh.Run ${vbsQuote(cmd)}, 0, False`,
    '',
  ].join('\r\n');
}

export function installAutostart(): { file: string; content: string } {
  const file = autostartFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = buildVbs();
  // UTF-16LE z BOM: Windows Script Host poprawnie czyta wtedy ścieżki z polskimi znakami.
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
  return { file, content };
}

export function uninstallAutostart(): { file: string; removed: boolean } {
  const file = autostartFile();
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return { file, removed: existed };
}

export function autostartInstalled(): boolean {
  return fs.existsSync(autostartFile());
}
