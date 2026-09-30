import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PACKAGE_ROOT } from '../src/core/index.js';

export const WORKER_JS = path.join(PACKAGE_ROOT, 'dist', 'worker', 'index.js');
export const STDIO_JS = path.join(PACKAGE_ROOT, 'dist', 'mcp-stdio', 'index.js');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** Środowisko izolowane od .env w repozytorium i od prawdziwego katalogu danych. */
export function isolatedEnv(dataDir: string, port: number, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return {
    ...env,
    LINKEDIN_MCP_DATA_DIR: dataDir,
    LINKEDIN_MCP_ENV_FILE: path.join(dataDir, 'none.env'),
    LINKEDIN_MODE: 'mock',
    WORKER_PORT: String(port),
    ...extra,
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Przekroczono czas oczekiwania');
}

export async function startWorkerProcess(env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, [WORKER_JS], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += String(d)));
  const port = env.WORKER_PORT;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Worker zakończył się: ${stderr}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      return r.ok;
    } catch {
      return false;
    }
  });
  return child;
}

export function readToken(dataDir: string): string {
  return fs.readFileSync(path.join(dataDir, 'worker-token'), 'utf8').trim();
}
