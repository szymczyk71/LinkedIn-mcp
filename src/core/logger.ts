import fs from 'node:fs';
import { redact } from './util.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, detail?: Record<string, unknown>): void;
  info(msg: string, detail?: Record<string, unknown>): void;
  warn(msg: string, detail?: Record<string, unknown>): void;
  error(msg: string, detail?: Record<string, unknown>): void;
}

/**
 * Logger pisze na stderr (stdout zostaje wolny, co ma znaczenie dla transportu stdio)
 * i opcjonalnie do pliku. Szczegóły przechodzą przez redact().
 */
export function createLogger(opts: { file?: string | null; level?: LogLevel; stderr?: boolean } = {}): Logger {
  const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const min = order.indexOf(opts.level ?? 'info');
  const write = (level: LogLevel, msg: string, detail?: Record<string, unknown>) => {
    if (order.indexOf(level) < min) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${detail ? ' ' + JSON.stringify(redact(detail)) : ''}`;
    if (opts.stderr !== false) process.stderr.write(line + '\n');
    if (opts.file) {
      try {
        fs.appendFileSync(opts.file, line + '\n', 'utf8');
      } catch {
        /* log pomocniczy */
      }
    }
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
