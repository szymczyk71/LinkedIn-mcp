import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/core/index.js';
import { buildVbs, installAutostart, uninstallAutostart, autostartFile } from '../src/cli/autostart.js';
import { SERVER_NAME, serverEntry, writeClaudeConfig } from '../src/cli/claude-config.js';
import { startWorkerDetached, stopWorker, workerHealth } from '../src/worker/control.js';
import { freePort, isolatedEnv, waitFor } from './process-helpers.js';
import { tmpDataDir } from './helpers.js';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function isolated(): Promise<{ config: Config; env: Record<string, string> }> {
  const dataDir = tmpDataDir();
  const env = isolatedEnv(dataDir, await freePort());
  const config = loadConfig(env, { envFile: false });
  cleanups.push(() => stopWorker(config));
  return { config, env };
}

describe('worker w tle', () => {
  it('start (odłączony), ponowny start = już działa, stop', async () => {
    const { config, env } = await isolated();
    expect((await workerHealth(config)).running).toBe(false);

    const started = await startWorkerDetached(config, env);
    expect(started).toMatchObject({ started: true, alreadyRunning: false });
    expect(started.pid).toBeGreaterThan(0);
    expect((await workerHealth(config)).running).toBe(true);

    expect(await startWorkerDetached(config, env)).toMatchObject({ started: false, alreadyRunning: true, pid: started.pid });

    expect((await stopWorker(config)).stopped).toBe(true);
    expect((await workerHealth(config)).running).toBe(false);
    expect(fs.existsSync(path.join(config.paths.dataDir, 'worker.pid'))).toBe(false); // łagodne zatrzymanie sprząta blokadę
    expect(fs.readFileSync(config.paths.workerLogFile, 'utf8')).toMatch(/Worker zatrzymuje się/);
  }, 60_000);

  it('błąd startu jest czytelny (zajęty port)', async () => {
    const { config, env } = await isolated();
    const net = await import('node:net');
    const blocker = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => blocker.listen(config.workerPort, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise((r) => blocker.close(r)));
    const r = await startWorkerDetached(config, env);
    expect(r.started).toBe(false);
    expect(r.message).toMatch(/jest zajęty/);
  }, 60_000);
});

describe('autostart przy logowaniu (folder Autostart)', () => {
  it('install/uninstall w folderze Autostart; plik .vbs uruchamia worker bez okna', async () => {
    const startup = tmpDataDir();
    process.env.LINKEDIN_MCP_STARTUP_DIR = startup;
    cleanups.push(() => delete process.env.LINKEDIN_MCP_STARTUP_DIR);

    const { file, content } = installAutostart();
    expect(file).toBe(path.join(startup, 'LinkedIn MCP Worker.vbs'));
    const raw = fs.readFileSync(file);
    expect([raw[0], raw[1]]).toEqual([0xff, 0xfe]); // UTF-16LE BOM
    expect(content).toContain(process.execPath);
    expect(content).toContain(path.join('dist', 'cli', 'index.js'));
    expect(content).toMatch(/worker start"", 0, False|worker start", 0, False/);

    // Uruchomienie skryptu tak, jak zrobi to Windows po zalogowaniu (środowisko izolowane, dziedziczone przez WScript.Shell.Run).
    const { config, env } = await isolated();
    const cs = spawn('cscript.exe', ['//nologo', file], { env, stdio: 'ignore' });
    await new Promise((r) => cs.once('exit', r));
    await waitFor(async () => (await workerHealth(config)).running, 20_000);

    expect(uninstallAutostart()).toMatchObject({ removed: true });
    expect(fs.existsSync(autostartFile())).toBe(false);
  }, 60_000);

  it('cudzysłowy w ścieżkach są poprawnie escapowane w VBS', () => {
    const vbs = buildVbs('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Łukasz Ś\\repo');
    expect(vbs).toContain('sh.CurrentDirectory = "C:\\Users\\Łukasz Ś\\repo"');
    expect(vbs).toContain('sh.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\Łukasz Ś\\repo\\dist\\cli\\index.js"" worker start", 0, False');
  });
});

describe('konfiguracja Claude Desktop', () => {
  it('dopisuje serwer "linkedin", zachowuje resztę pliku i robi kopię zapasową', () => {
    const file = path.join(tmpDataDir(), 'claude_desktop_config.json');
    fs.writeFileSync(file, JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: { other: { command: 'x', args: [] } } }));
    const r = writeClaudeConfig(file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.preferences).toEqual({ theme: 'dark' });
    expect(data.mcpServers.other).toEqual({ command: 'x', args: [] });
    expect(data.mcpServers[SERVER_NAME]).toEqual(serverEntry());
    expect(path.isAbsolute(data.mcpServers[SERVER_NAME].command)).toBe(true);
    expect(path.isAbsolute(data.mcpServers[SERVER_NAME].args[0])).toBe(true);
    expect(fs.existsSync(r.backup!)).toBe(true);

    writeClaudeConfig(file); // ponownie - bez duplikatów
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers)).toEqual(['other', SERVER_NAME]);
  });

  it('tworzy plik, gdy go nie ma; odmawia zapisu uszkodzonego JSON', () => {
    const dir = tmpDataDir();
    const fresh = path.join(dir, 'nowy', 'claude_desktop_config.json');
    expect(writeClaudeConfig(fresh).backup).toBeNull();
    expect(JSON.parse(fs.readFileSync(fresh, 'utf8')).mcpServers[SERVER_NAME]).toBeTruthy();

    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{ "a": ');
    expect(() => writeClaudeConfig(broken)).toThrow(/nie jest poprawnym JSON/);
    expect(fs.readFileSync(broken, 'utf8')).toBe('{ "a": ');
  });
});
