import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, PACKAGE_ROOT, describeConfig, loadConfig } from '../src/core/index.js';
import { tmpDataDir } from './helpers.js';

describe('konfiguracja', () => {
  it('domyślnie tryb mock, Europe/Warsaw, 127.0.0.1 i wartości z promptu', () => {
    const c = loadConfig({ LINKEDIN_MCP_DATA_DIR: tmpDataDir() }, { envFile: false });
    expect(c.mode).toBe('mock');
    expect(c.defaultTimezone).toBe('Europe/Warsaw');
    expect(c.workerHost).toBe('127.0.0.1');
    expect(c.minLeadMin).toBe(5);
    expect(c.missedGraceMin).toBe(60);
    expect(c.linkedin.redirectUri).toBe('http://127.0.0.1:47811/oauth/callback');
  });

  it('tryb live tylko po jawnym ustawieniu', () => {
    expect(loadConfig({ LINKEDIN_MCP_DATA_DIR: tmpDataDir(), LINKEDIN_MODE: 'live' }, { envFile: false }).mode).toBe('live');
    expect(() => loadConfig({ LINKEDIN_MCP_DATA_DIR: tmpDataDir(), LINKEDIN_MODE: 'prod' }, { envFile: false })).toThrow(ConfigError);
  });

  it('odrzuca katalog danych wewnątrz repozytorium', () => {
    expect(() => loadConfig({ LINKEDIN_MCP_DATA_DIR: path.join(PACKAGE_ROOT, 'data') }, { envFile: false })).toThrow(/repozytorium/);
  });

  it('nie pozwala zejść z minimalnym wyprzedzeniem poniżej 5 minut', () => {
    expect(() => loadConfig({ LINKEDIN_MCP_DATA_DIR: tmpDataDir(), MIN_LEAD_MIN: '2' }, { envFile: false })).toThrow(ConfigError);
  });

  it('opis konfiguracji nie zawiera sekretów', () => {
    const c = loadConfig(
      { LINKEDIN_MCP_DATA_DIR: tmpDataDir(), LINKEDIN_CLIENT_SECRET: 'super-tajne', LINKEDIN_CLIENT_ID: 'abc' },
      { envFile: false },
    );
    const text = JSON.stringify(describeConfig(c));
    expect(text).not.toContain('super-tajne');
    expect(describeConfig(c).linkedinClientConfigured).toBe(true);
  });
});
