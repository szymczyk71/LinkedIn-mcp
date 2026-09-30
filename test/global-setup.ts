import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Testy procesów (worker, stdio) uruchamiają skompilowany kod z dist/. */
export default function setup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}
