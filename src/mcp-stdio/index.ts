#!/usr/bin/env node
/**
 * Cienka nakładka MCP (transport stdio) dla Claude Desktop.
 * Nie ma własnej logiki ani bazy - każde narzędzie przekazuje do lokalnego API workera.
 * Uwaga: stdout należy do protokołu MCP, wszystkie komunikaty idą na stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PACKAGE_ROOT, loadConfig, type Config } from '../core/config.js';
import { readWorkerToken } from '../core/worker-token.js';
import { registerTools, type ToolInvoker, type ToolOutcome } from '../mcp/tools.js';

const VERSION = '0.3.0';

function startHint(): string {
  return `Uruchom worker w PowerShell: cd "${PACKAGE_ROOT}"; npm run worker:start (w tle) albo npm run worker (na pierwszym planie).`;
}

export function createWorkerInvoker(getConfig: () => Config): ToolInvoker {
  return async (name, args): Promise<ToolOutcome> => {
    let config: Config;
    try {
      config = getConfig();
    } catch (e) {
      return { ok: false, error: { code: 'config_error', message: e instanceof Error ? e.message : String(e) } };
    }
    const base = `http://${config.workerHost}:${config.workerPort}`;
    const token = readWorkerToken(config.paths.workerTokenFile);
    if (!token) {
      return {
        ok: false,
        error: { code: 'worker_not_running', message: `Worker LinkedIn nie działa (brak tokenu dostępu w ${config.paths.dataDir}). ${startHint()}` },
      };
    }
    let res: Response;
    try {
      res = await fetch(`${base}/api/tools/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(args ?? {}),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      const timedOut = (e as Error).name === 'TimeoutError';
      return {
        ok: false,
        error: {
          code: timedOut ? 'worker_timeout' : 'worker_not_running',
          message: timedOut
            ? 'Worker LinkedIn nie odpowiedział w ciągu 60 s. Sprawdź worker.log.'
            : `Worker LinkedIn nie działa (brak połączenia z ${base}${cause ? `, ${cause}` : ''}). ${startHint()}`,
        },
      };
    }
    if (res.status === 401) {
      return { ok: false, error: { code: 'worker_auth_failed', message: 'Worker odrzucił token dostępu. Uruchom ponownie worker i Claude Desktop.' } };
    }
    try {
      return (await res.json()) as ToolOutcome;
    } catch {
      return { ok: false, error: { code: 'worker_bad_response', message: `Niepoprawna odpowiedź workera (HTTP ${res.status}).` } };
    }
  };
}

async function main(): Promise<void> {
  let cached: Config | null = null;
  const getConfig = () => (cached ??= loadConfig());
  const server = new McpServer({ name: 'linkedin-mcp', version: VERSION });
  registerTools(server, createWorkerInvoker(getConfig));
  await server.connect(new StdioServerTransport());
  process.stderr.write('linkedin-mcp (stdio) gotowy\n');
}

main().catch((e: unknown) => {
  process.stderr.write(`linkedin-mcp (stdio) nie wystartował: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
