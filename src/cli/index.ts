#!/usr/bin/env node
import fs from 'node:fs';
import {
  AuditLog,
  MockScenarioSchema,
  SqliteStore,
  clearPause,
  describeConfig,
  ensureDataDir,
  formatLocal,
  loadConfig,
  readPause,
  setPause,
  type Config,
  type MockScenario,
} from '../core/index.js';
import { outLogFile, startWorkerDetached, stopWorker, tail, workerHealth } from '../worker/control.js';
import { autostartFile, autostartInstalled, installAutostart, uninstallAutostart } from './autostart.js';
import { deleteLivePost, tokenClear, tokenImport, tokenStatus, tokenVerify } from './token-commands.js';
import { SERVER_NAME, defaultClaudeConfigPath, findClaudeConfigCandidates, serverEntry, snippet, writeClaudeConfig } from './claude-config.js';

const HELP = `Użycie: npm run cli -- <komenda>   (albo skróty npm run ... podane w nawiasach)

  status                      pełny stan: worker, autostart, pauza, kolejka, Claude Desktop  (npm run status)
  doctor                      konfiguracja, ścieżki, stan bazy                               (npm run doctor)

  worker start                uruchom worker w tle, bez okna                                 (npm run worker:start)
  worker stop                 zatrzymaj worker                                               (npm run worker:stop)
  worker restart              zatrzymaj i uruchom ponownie                                   (npm run worker:restart)
  worker status               czy worker działa                                              (npm run worker:status)
  worker logs [n]             ostatnie n linii worker.log (domyślnie 40)                     (npm run worker:logs)

  autostart install           uruchamiaj worker przy logowaniu do Windows                   (npm run autostart:install)
  autostart uninstall         wyłącz autostart                                               (npm run autostart:uninstall)
  autostart status

  claude-config               pokaż fragment claude_desktop_config.json                     (npm run claude-config)
  claude-config --write [--path <plik>]
                              dopisz serwer "linkedin" do konfiguracji Claude Desktop (z kopią zapasową)

  login                       adres strony logowania OAuth                                   (npm run login)
  token status                stan zapisanego tokenu (bez samego tokenu)                     (npm run token:status)
  token verify                sprawdź token wywołaniem userinfo (1 wywołanie API)
  token import [--expires-in-days 60] [--scopes "openid profile w_member_social"]
                              import tokenu z Developer Portal (Token Generator)            (npm run token:import)
  token clear                 usuń token z tego komputera (wylogowanie)
  linkedin delete-post <id> [--yes]
                              usuń opublikowany post z LinkedIn (sprzątanie po teście)

  pause [powód]               bezpiecznik: harmonogram niczego nie publikuje                 (npm run pause)
  resume                      wyłącz bezpiecznik                                             (npm run resume)

  mock show | reset | posts
  mock set op=tryb[:razy] ... np. mock set publish=timeout   mock set comment=forbidden:1
                              op: publish, comment, auth, delayMs
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  const config = loadConfig();
  ensureDataDir(config.paths);

  switch (cmd) {
    case 'status':
      print(await fullStatus(config));
      return 0;

    case 'doctor': {
      const store = new SqliteStore(config.paths.dbFile);
      const counts: Record<string, number> = {};
      for (const p of await store.listPosts({ limit: 100_000 })) counts[p.status] = (counts[p.status] ?? 0) + 1;
      print({ config: describeConfig(config), pause: readPause(config.paths.pauseFlagFile), posts: counts });
      await store.close();
      return 0;
    }

    case 'worker':
      return workerCommand(config, sub, rest);

    case 'autostart':
      if (sub === 'install') {
        const r = installAutostart();
        print({ installed: true, file: r.file, message: 'Worker uruchomi się automatycznie po zalogowaniu do Windows.' });
        return 0;
      }
      if (sub === 'uninstall') {
        const r = uninstallAutostart();
        print({ installed: false, file: r.file, removed: r.removed });
        return 0;
      }
      print({ installed: autostartInstalled(), file: autostartFile() });
      return 0;

    case 'claude-config': {
      const args = [sub, ...rest].filter((a): a is string => a !== undefined);
      const pathIdx = args.indexOf('--path');
      const file = pathIdx >= 0 ? args[pathIdx + 1] : defaultClaudeConfigPath();
      if (!file) throw new Error('Po --path podaj ścieżkę pliku.');
      if (args.includes('--write')) {
        const r = writeClaudeConfig(file);
        print({ written: true, ...r, server: SERVER_NAME, entry: serverEntry(), message: 'Zamknij Claude Desktop całkowicie (także z zasobnika) i uruchom ponownie.' });
      } else {
        process.stdout.write(`Plik konfiguracji Claude Desktop: ${file}\n\nFragment do wklejenia (sekcja mcpServers):\n\n${snippet()}\n\nAutomatycznie: npm run claude-config -- --write\n`);
      }
      return 0;
    }

    case 'token': {
      const args = rest;
      if (sub === 'import') print(await tokenImport(config, args));
      else if (sub === 'clear') print(await tokenClear(config));
      else if (sub === 'verify') print(await tokenVerify(config));
      else print(await tokenStatus(config));
      return 0;
    }

    case 'login':
      process.stdout.write(
        `Otwórz w przeglądarce (worker musi działać): http://${config.workerHost}:${config.workerPort}/oauth/start\n` +
          `Adres przekierowania w Developer Portal musi być dokładnie: ${config.linkedin.redirectUri}\n`,
      );
      return 0;

    case 'linkedin':
      if (sub === 'delete-post') {
        print(await deleteLivePost(config, rest[0], rest.includes('--yes')));
        return 0;
      }
      process.stderr.write(HELP);
      return 2;

    case 'pause': {
      const info = setPause(config.paths.pauseFlagFile, [sub, ...rest].filter(Boolean).join(' ') || null);
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
      return mockCommand(config.paths.mockScenarioFile, config.paths.mockStateFile, [sub, ...rest].filter((a): a is string => a !== undefined));
    default:
      process.stderr.write(`Nieznana komenda: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

async function workerCommand(config: Config, sub: string | undefined, rest: string[]): Promise<number> {
  switch (sub) {
    case 'start': {
      const r = await startWorkerDetached(config);
      print(r);
      if (r.started || r.alreadyRunning) await auditCli(config, 'worker_start_cli', { alreadyRunning: r.alreadyRunning });
      return r.started || r.alreadyRunning ? 0 : 1;
    }
    case 'stop': {
      const r = await stopWorker(config);
      print(r);
      return r.stopped || r.message === 'Worker nie działa.' ? 0 : 1;
    }
    case 'restart': {
      await stopWorker(config);
      const r = await startWorkerDetached(config);
      print(r);
      return r.started ? 0 : 1;
    }
    case 'logs': {
      const n = Number(rest[0] ?? 40);
      process.stdout.write(tail(config.paths.workerLogFile, n) + '\n');
      const out = tail(outLogFile(config), 10);
      if (out !== '(brak pliku)' && out.trim()) process.stdout.write(`\n--- ${outLogFile(config)} ---\n${out}\n`);
      return 0;
    }
    case 'status':
    case undefined: {
      const h = await workerHealth(config);
      print({ ...h, logFile: config.paths.workerLogFile });
      return h.running ? 0 : 1;
    }
    default:
      process.stderr.write(HELP);
      return 2;
  }
}

async function fullStatus(config: Config) {
  const store = new SqliteStore(config.paths.dbFile);
  try {
    const counts: Record<string, number> = {};
    for (const p of await store.listPosts({ limit: 100_000 })) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const next = (await store.listPosts({ status: 'scheduled', fromUtc: new Date().toISOString(), limit: 5 })).map((p) => ({
      id: p.id,
      publish_at_local: formatLocal(p.publishAtUtc, p.timezone),
      text_start: [...p.text].slice(0, 60).join(''),
    }));
    const attention = (await store.listPosts({ status: ['failed', 'missed'], limit: 20 })).map((p) => ({
      id: p.id,
      status: p.status,
      publish_at_local: formatLocal(p.publishAtUtc, p.timezone),
      error: p.lastError?.code ?? null,
    }));
    const claudeFile = defaultClaudeConfigPath();
    let claudeConfigured = false;
    try {
      claudeConfigured = Boolean((JSON.parse(fs.readFileSync(claudeFile, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers?.[SERVER_NAME]);
    } catch {
      /* brak pliku */
    }
    return {
      mode: config.mode,
      worker: await workerHealth(config),
      autostart: { installed: autostartInstalled(), file: autostartFile() },
      pause: readPause(config.paths.pauseFlagFile),
      posts: counts,
      next_scheduled: next,
      needs_attention: attention,
      claude_desktop: { configFile: claudeFile, serverConfigured: claudeConfigured, candidates: findClaudeConfigCandidates() },
      dataDir: config.paths.dataDir,
    };
  } finally {
    await store.close();
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
      if (key === 'delayMs') current.delayMs = Number(value);
      else if (key === 'auth') current.auth = value;
      else {
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

async function auditCli(config: Config, action: string, detail: Record<string, unknown> | null) {
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
    process.stderr.write(`Błąd: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
