import fs from 'node:fs';
import type { Store } from './db/store.js';
import type { Actor, AuditEntry } from './model.js';
import { redact, type Clock, systemClock } from './util.js';

/**
 * Dziennik audytu: każda operacja trafia do bazy i do pliku JSONL (dopisywanie).
 * Szczegóły przechodzą przez redact(), więc sekrety nie trafiają do logu.
 */
export class AuditLog {
  constructor(
    private readonly store: Store,
    private readonly file: string | null,
    private readonly clock: Clock = systemClock,
  ) {}

  async record(
    actor: Actor,
    action: string,
    result: AuditEntry['result'],
    target: string | null = null,
    detail: Record<string, unknown> | null = null,
  ): Promise<void> {
    const entry: AuditEntry = {
      at: this.clock.now().toISOString(),
      actor,
      action,
      target,
      result,
      detail: detail ? redact(detail) : null,
    };
    await this.store.appendAudit(entry);
    if (this.file) {
      try {
        fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
      } catch {
        // Plik audytu jest kopią pomocniczą; źródłem prawdy jest baza.
      }
    }
  }
}
