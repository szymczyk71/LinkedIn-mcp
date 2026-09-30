import { DateTime } from 'luxon';

/**
 * Konwersje czasu. Wejście: czas lokalny bez strefy (ISO 8601) + nazwa strefy IANA.
 * W bazie trzymamy wyłącznie UTC.
 *
 * Zmiana czasu:
 * - godzina nieistniejąca (luka wiosną, np. 2027-03-28 02:30 w Europe/Warsaw) -> błąd,
 * - godzina podwójna (jesienią, np. 2026-10-25 02:30) -> pierwsze wystąpienie (czas letni) + ostrzeżenie.
 */

const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export class TimeInputError extends Error {
  override name = 'TimeInputError';
  constructor(
    readonly code: 'invalid_datetime' | 'nonexistent_local_time' | 'invalid_timezone',
    message: string,
  ) {
    super(message);
  }
}

export interface ParsedLocalTime {
  utc: string;
  warnings: string[];
}

export function parseLocalDateTime(input: string, zone: string): ParsedLocalTime {
  if (!DateTime.local().setZone(zone).isValid) {
    throw new TimeInputError('invalid_timezone', `Nieznana strefa czasowa: ${zone}`);
  }
  const m = LOCAL_ISO.exec(input.trim());
  if (!m) {
    throw new TimeInputError(
      'invalid_datetime',
      `Niepoprawny termin "${input}". Oczekiwany format: RRRR-MM-DDTGG:MM[:SS] bez strefy, np. 2026-11-06T08:00:00.`,
    );
  }
  const [, y, mo, d, h, mi, s] = m;
  const wall = { year: +y!, month: +mo!, day: +d!, hour: +h!, minute: +mi!, second: s ? +s : 0 };
  const dt = DateTime.fromObject(wall, { zone });
  if (!dt.isValid) {
    throw new TimeInputError('invalid_datetime', `Niepoprawna data "${input}": ${dt.invalidExplanation ?? dt.invalidReason}.`);
  }
  // Luxon przesuwa godzinę z luki do przodu - wykrywamy to porównując czas "na zegarze".
  if (dt.year !== wall.year || dt.month !== wall.month || dt.day !== wall.day || dt.hour !== wall.hour || dt.minute !== wall.minute) {
    throw new TimeInputError(
      'nonexistent_local_time',
      `Godzina ${input} nie istnieje w strefie ${zone} (przestawienie zegarów na czas letni). Wybierz inną godzinę.`,
    );
  }
  const warnings: string[] = [];
  const offsets = dt.getPossibleOffsets();
  let chosen = dt;
  if (offsets.length > 1) {
    // Pierwsze wystąpienie = większy offset (czas letni, wcześniejszy moment UTC).
    chosen = offsets.reduce((a, b) => (a.toMillis() <= b.toMillis() ? a : b));
    warnings.push(
      `Godzina ${input} występuje dwa razy (zmiana czasu na zimowy). Przyjęto pierwsze wystąpienie: ${chosen.toISO({ suppressMilliseconds: true })}.`,
    );
  }
  return { utc: chosen.toUTC().toISO()!, warnings };
}

/** Czas lokalny do odpowiedzi, np. "2026-11-06T08:00:00+01:00". */
export function formatLocal(utcIso: string, zone: string): string {
  return DateTime.fromISO(utcIso, { zone: 'utc' }).setZone(zone).toISO({ suppressMilliseconds: true })!;
}

/**
 * Chwila przebiegu harmonogramu, w którym post faktycznie wyjdzie: najbliższa wielokrotność
 * interwału >= terminu (przebiegi są wyrównane do zegara, np. :00, :05, :10).
 * Polska ma pełnogodzinne przesunięcia względem UTC, więc wyrównanie w UTC = wyrównanie lokalne.
 */
export function nextTickUtc(utcIso: string, intervalMin: number): string {
  const ms = new Date(utcIso).getTime();
  const step = intervalMin * 60_000;
  return new Date(Math.ceil(ms / step) * step).toISOString();
}

/** Okno przebiegu (start, koniec], do którego trafia termin. */
export function tickWindow(utcIso: string, intervalMin: number): { startExclusive: string; endInclusive: string } {
  const end = nextTickUtc(utcIso, intervalMin);
  return { startExclusive: new Date(new Date(end).getTime() - intervalMin * 60_000).toISOString(), endInclusive: end };
}

export function minutesBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000;
}
