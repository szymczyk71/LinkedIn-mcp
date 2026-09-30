import { describe, expect, it } from 'vitest';
import { TimeInputError, formatLocal, nextTickUtc, parseLocalDateTime, tickWindow } from '../src/core/index.js';

const TZ = 'Europe/Warsaw';

describe('czas lokalny -> UTC (Europe/Warsaw)', () => {
  it('czas zimowy: +01:00', () => {
    expect(parseLocalDateTime('2026-11-06T08:00:00', TZ)).toEqual({ utc: '2026-11-06T07:00:00.000Z', warnings: [] });
  });

  it('czas letni: +02:00', () => {
    expect(parseLocalDateTime('2026-10-01T08:00:00', TZ).utc).toBe('2026-10-01T06:00:00.000Z');
  });

  it('dzień przejścia na czas zimowy (25.10.2026): przed i po zmianie', () => {
    expect(parseLocalDateTime('2026-10-25T01:30:00', TZ).utc).toBe('2026-10-24T23:30:00.000Z');
    expect(parseLocalDateTime('2026-10-25T09:00:00', TZ).utc).toBe('2026-10-25T08:00:00.000Z');
    // Ta sama godzina dzień wcześniej to inne UTC - zegar się przestawił.
    expect(parseLocalDateTime('2026-10-24T09:00:00', TZ).utc).toBe('2026-10-24T07:00:00.000Z');
  });

  it('godzina podwójna jesienią: pierwsze wystąpienie (czas letni) + ostrzeżenie', () => {
    const r = parseLocalDateTime('2026-10-25T02:30:00', TZ);
    expect(r.utc).toBe('2026-10-25T00:30:00.000Z');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/dwa razy/);
  });

  it('dzień przejścia na czas letni (28.03.2027): przed i po zmianie', () => {
    expect(parseLocalDateTime('2027-03-28T01:30:00', TZ).utc).toBe('2027-03-28T00:30:00.000Z');
    expect(parseLocalDateTime('2027-03-28T03:00:00', TZ).utc).toBe('2027-03-28T01:00:00.000Z');
    expect(parseLocalDateTime('2027-03-29T09:00:00', TZ).utc).toBe('2027-03-29T07:00:00.000Z');
  });

  it('godzina nieistniejąca wiosną -> błąd nonexistent_local_time', () => {
    for (const t of ['2027-03-28T02:00:00', '2027-03-28T02:30:00', '2027-03-28T02:59']) {
      expect(() => parseLocalDateTime(t, TZ)).toThrow(TimeInputError);
      try {
        parseLocalDateTime(t, TZ);
      } catch (e) {
        expect((e as TimeInputError).code).toBe('nonexistent_local_time');
      }
    }
  });

  it('odrzuca terminy ze strefą, złym formatem i nieistniejące daty', () => {
    for (const t of ['2026-11-06T08:00:00Z', '2026-11-06T08:00:00+01:00', '06.11.2026 08:00', '2026-02-30T08:00:00', '2026-11-06', '']) {
      expect(() => parseLocalDateTime(t, TZ), t).toThrow(TimeInputError);
    }
  });

  it('przyjmuje termin bez sekund', () => {
    expect(parseLocalDateTime('2026-11-06T08:00', TZ).utc).toBe('2026-11-06T07:00:00.000Z');
  });

  it('nieznana strefa', () => {
    expect(() => parseLocalDateTime('2026-11-06T08:00:00', 'Mars/Olympus')).toThrow(/strefa/);
  });

  it('formatLocal pokazuje właściwy offset po obu stronach zmiany czasu', () => {
    expect(formatLocal('2026-10-25T00:30:00.000Z', TZ)).toBe('2026-10-25T02:30:00+02:00');
    expect(formatLocal('2026-10-25T01:30:00.000Z', TZ)).toBe('2026-10-25T02:30:00+01:00');
    expect(formatLocal('2027-03-28T01:00:00.000Z', TZ)).toBe('2027-03-28T03:00:00+02:00');
  });
});

describe('wyrównanie do przebiegu harmonogramu (co 5 min)', () => {
  it('termin na pełnych 5 minutach wychodzi punktualnie', () => {
    expect(nextTickUtc('2026-11-06T07:00:00.000Z', 5)).toBe('2026-11-06T07:00:00.000Z');
  });
  it('termin pomiędzy przebiegami wychodzi w następnym', () => {
    expect(nextTickUtc('2026-11-06T07:02:00.000Z', 5)).toBe('2026-11-06T07:05:00.000Z');
    expect(nextTickUtc('2026-11-06T07:00:01.000Z', 5)).toBe('2026-11-06T07:05:00.000Z');
  });
  it('okno przebiegu (start, koniec]', () => {
    expect(tickWindow('2026-11-06T07:03:00.000Z', 5)).toEqual({
      startExclusive: '2026-11-06T07:00:00.000Z',
      endInclusive: '2026-11-06T07:05:00.000Z',
    });
  });
});
