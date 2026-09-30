import fs from 'node:fs';
import path from 'node:path';

/** Blokada pojedynczej instancji workera: plik worker.pid z PID działającego procesu. */
export class InstanceLock {
  private constructor(private readonly file: string) {}

  static acquire(dataDir: string): InstanceLock {
    const file = path.join(dataDir, 'worker.pid');
    if (fs.existsSync(file)) {
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
        throw new Error(`Worker już działa (PID ${pid}). Zatrzymaj go przed uruchomieniem kolejnej instancji.`);
      }
    }
    fs.writeFileSync(file, String(process.pid), 'utf8');
    return new InstanceLock(file);
  }

  release(): void {
    try {
      if (fs.readFileSync(this.file, 'utf8').trim() === String(process.pid)) fs.rmSync(this.file, { force: true });
    } catch {
      /* już usunięty */
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
