import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, type Config } from '../core/config.js';
import { readWorkerToken } from '../core/worker-token.js';

export const WORKER_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'worker', 'index.js');

export interface WorkerHealth {
  running: boolean;
  pid: number | null;
  mode: string | null;
  url: string;
}

export function outLogFile(config: Config): string {
  return path.join(config.paths.dataDir, 'worker.out.log');
}

export async function workerHealth(config: Config, timeoutMs = 2000): Promise<WorkerHealth> {
  const url = `http://${config.workerHost}:${config.workerPort}`;
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await r.json()) as { ok?: boolean; pid?: number; mode?: string; service?: string };
    if (body.service !== 'linkedin-mcp-worker') return { running: false, pid: null, mode: null, url };
    return { running: true, pid: body.pid ?? null, mode: body.mode ?? null, url };
  } catch {
    return { running: false, pid: null, mode: null, url };
  }
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export type StartResult = { started: boolean; alreadyRunning: boolean; pid: number | null; message: string };

/** Uruchamia worker jako odłączony proces w tle (bez okna konsoli). */
export async function startWorkerDetached(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<StartResult> {
  const before = await workerHealth(config);
  if (before.running) return { started: false, alreadyRunning: true, pid: before.pid, message: `Worker już działa (PID ${before.pid}, ${before.url}).` };

  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  const out = fs.openSync(outLogFile(config), 'a');
  const child = spawn(process.execPath, [WORKER_ENTRY], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...env, LINKEDIN_MCP_DETACHED: '1' },
    cwd: path.dirname(WORKER_ENTRY),
  });
  let exited = false;
  child.once('exit', () => (exited = true));
  child.unref();
  fs.closeSync(out);

  const ok = await waitUntil(async () => exited || (await workerHealth(config, 1000)).running, 15_000);
  if (!ok || exited) {
    const why = exited ? 'Worker zakończył się zaraz po starcie.' : 'Worker nie odpowiada po starcie.';
    return { started: false, alreadyRunning: false, pid: null, message: `${why} Ostatnie linie ${outLogFile(config)}:\n${tail(outLogFile(config), 15)}` };
  }
  const h = await workerHealth(config);
  return { started: true, alreadyRunning: false, pid: h.pid, message: `Worker działa w tle (PID ${h.pid}, ${h.url}).` };
}

/** Łagodne zatrzymanie przez API (z tokenem); awaryjnie zabicie procesu z worker.pid. */
export async function stopWorker(config: Config): Promise<{ stopped: boolean; message: string }> {
  const h = await workerHealth(config);
  if (!h.running) return { stopped: false, message: 'Worker nie działa.' };
  const token = readWorkerToken(config.paths.workerTokenFile);
  if (token) {
    try {
      await fetch(`${h.url}/api/admin/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    } catch {
      /* worker mógł zamknąć połączenie w trakcie wyłączania */
    }
  }
  if (await waitUntil(async () => !(await workerHealth(config, 500)).running, 10_000)) return { stopped: true, message: 'Worker zatrzymany.' };
  if (h.pid) {
    try {
      process.kill(h.pid);
    } catch {
      /* już nie działa */
    }
  }
  const down = await waitUntil(async () => !(await workerHealth(config, 500)).running, 5_000);
  return { stopped: down, message: down ? 'Worker zatrzymany (wymuszenie).' : 'Nie udało się zatrzymać workera.' };
}

export function tail(file: string, lines: number): string {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(brak pliku)';
  }
}
