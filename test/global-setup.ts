import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Adres testowej bazy PostgreSQL albo null, gdy Docker jest niedostępny (testy PostgreSQL są wtedy pomijane). */
    pgUrl: string | null;
  }
}

/**
 * 1. Buduje dist/ (testy procesów uruchamiają skompilowany kod).
 * 2. Uruchamia jednorazowy PostgreSQL w Dockerze (albo używa TEST_DATABASE_URL).
 */
export default async function setup(project: TestProject): Promise<() => void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });

  if (process.env.TEST_DATABASE_URL) {
    project.provide('pgUrl', process.env.TEST_DATABASE_URL);
    return () => {};
  }
  const name = `linkedin-mcp-test-pg-${crypto.randomBytes(4).toString('hex')}`;
  try {
    execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test', '-p', '127.0.0.1::5432', 'postgres:17-alpine'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    });
    const port = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
    const url = `postgres://postgres:test@127.0.0.1:${port}/test`;
    const end = Date.now() + 60_000;
    for (;;) {
      const c = new pg.Client({ connectionString: url });
      try {
        await c.connect();
        await c.query('SELECT 1');
        await c.end();
        break;
      } catch {
        await c.end().catch(() => {});
        if (Date.now() > end) throw new Error('PostgreSQL w Dockerze nie wystartował.');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    project.provide('pgUrl', url);
    return () => {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        /* już usunięty */
      }
    };
  } catch (e) {
    process.stderr.write(`\n[testy] PostgreSQL niedostępny (${e instanceof Error ? e.message.split('\n')[0] : e}) - testy PostgreSQL zostaną pominięte.\n`);
    project.provide('pgUrl', null);
    return () => {};
  }
}
