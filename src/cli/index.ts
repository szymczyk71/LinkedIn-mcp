#!/usr/bin/env node
import fs from 'node:fs';
import {
  AuditLog,
  ConfigError,
  MockScenarioSchema,
  SqliteStore,
  clearPause,
  describeConfig,
  ensureDataDir,
  loadConfig,
  readPause,
  setPause,
  type MockScenario,
} from '../core/index.js';

const HELP = `Użycie: npm run cli -- <komenda>

  doctor                      konfiguracja, ścieżki, stan bazy i pauzy
  pause [powód]               włącz bezpiecznik (harmonogram niczego nie publikuje)
  resume                      wyłącz bezpiecznik
  mock show                   pokaż bieżący scenariusz atrapy
  mock reset                  wyczyść scenariusz (wszystko "ok")
  mock set op=tryb[:razy] ... ustaw scenariusz, np.:
                                mock set publish=timeout
                                mock set publish=reject:1 comment=forbidden
                                mock set auth=disconnected
                                mock set delayMs=5000
  mock posts                  lista postów "opublikowanych" w atrapie
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  const config = loadConfig();
  ensureDataDir(config.paths);

  switch (cmd) {
    case 'doctor': {
      const store = new SqliteStore(config.paths.dbFile);
      const counts: Record<string, number> = {};
      for (const p of await store.listPosts({ limit: 100_000 })) counts[p.status] = (counts[p.status] ?? 0) + 1;
      print({ config: describeConfig(config), pause: readPause(config.paths.pauseFlagFile), posts: counts });
      await store.close();
      return 0;
    }
    case 'pause': {
      const info = setPause(config.paths.pauseFlagFile, rest.join(' ') || null);
      await auditCli(config, 'pause', { reason: info.reason });
      print({ ...info, message: 'Bezpiecznik włączony: harmonogram nie opublikuje niczego do komendy resume.' });
      return 0;
    }
    case 'resume': {
      const info = clearPause(config.paths.pauseFlagFile);
      await auditCli(config, 'resume', null);
      print({ ...info, message: 'Bezpiecznik wyłączony.' });
      return 0;
    }
    case 'mock':
      return mockCommand(config.paths.mockScenarioFile, config.paths.mockStateFile, rest);
    default:
      process.stderr.write(`Nieznana komenda: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

function mockCommand(scenarioFile: string, stateFile: string, args: string[]): number {
  const [sub, ...pairs] = args;
  if (sub === 'show') {
    print(fs.existsSync(scenarioFile) ? JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) : {});
    return 0;
  }
  if (sub === 'reset') {
    fs.rmSync(scenarioFile, { force: true });
    print({ scenario: {}, message: 'Scenariusz atrapy wyczyszczony.' });
    return 0;
  }
  if (sub === 'posts') {
    print(fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { posts: [] });
    return 0;
  }
  if (sub === 'set') {
    const current: Record<string, unknown> = fs.existsSync(scenarioFile) ? JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) : {};
    for (const pair of pairs) {
      const [key, value] = pair.split('=');
      if (!key || value === undefined) throw new Error(`Niepoprawny parametr "${pair}", oczekiwano op=tryb[:razy].`);
      if (key === 'delayMs') {
        current.delayMs = Number(value);
      } else if (key === 'auth') {
        current.auth = value;
      } else {
        const [mode, times] = value.split(':');
        current[key] = times ? { mode, times: Number(times) } : mode;
      }
    }
    const parsed: MockScenario = MockScenarioSchema.parse(current);
    fs.writeFileSync(scenarioFile, JSON.stringify(parsed, null, 2));
    print({ scenario: parsed });
    return 0;
  }
  process.stderr.write(HELP);
  return 2;
}

async function auditCli(config: ReturnType<typeof loadConfig>, action: string, detail: Record<string, unknown> | null) {
  const store = new SqliteStore(config.paths.dbFile);
  await new AuditLog(store, config.paths.auditLogFile).record('cli', action, 'ok', null, detail);
  await store.close();
}

function print(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    process.stderr.write(`Błąd: ${msg}\n`);
    process.exit(1);
  },
);
