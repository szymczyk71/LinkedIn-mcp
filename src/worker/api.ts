import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LOOPBACK_HOST, type CoreContext, type Logger } from '../core/index.js';
import { LinkedInService, ToolError } from '../core/service.js';
import { tokensEqual } from '../core/worker-token.js';
import { TOOL_NAMES, invokeOnService, type ToolName, type ToolOutcome } from '../mcp/tools.js';

const MAX_BODY = 1_000_000;

export interface ApiServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Lokalne API workera, wyłącznie na 127.0.0.1:
 *   GET  /api/health              - bez tokenu, bez danych wrażliwych
 *   POST /api/tools/<nazwa>       - wymaga Authorization: Bearer <token z pliku worker-token>
 *   POST /api/admin/shutdown      - łagodne zatrzymanie (z tokenem)
 *   GET  /oauth/start, /oauth/callback - logowanie LinkedIn (etap 5)
 * Nagłówek Host musi wskazywać na 127.0.0.1/localhost (ochrona przed DNS rebinding).
 */
export async function startApi(
  ctx: CoreContext,
  token: string,
  log: Logger,
  port = ctx.config.workerPort,
  onShutdown?: () => void,
): Promise<ApiServer> {
  const service = new LinkedInService(ctx, 'mcp');

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log.error('Błąd API', { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) send(res, 500, { ok: false, error: { code: 'internal_error', message: 'Wewnętrzny błąd workera.' } });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    const actualPort = (server.address() as AddressInfo).port;
    if (!hostAllowed(req.headers.host, actualPort)) return send(res, 403, { ok: false, error: { code: 'forbidden_host', message: 'Niedozwolony nagłówek Host.' } });

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true, service: 'linkedin-mcp-worker', mode: ctx.config.mode, pid: process.pid });
    }

    if (url.pathname === '/oauth/start' || url.pathname === '/oauth/callback') {
      res.writeHead(501, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><h1>Logowanie LinkedIn</h1><p>Logowanie OAuth zostanie włączone w etapie 5 (tryb live). W trybie atrapy nie jest potrzebne.</p>');
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/shutdown') {
      if (!authorized(req.headers.authorization, token)) {
        return send(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Brak lub niepoprawny token workera.' } });
      }
      send(res, 200, { ok: true, message: 'Worker zatrzymuje się.' });
      setTimeout(() => onShutdown?.(), 50);
      return;
    }

    const m = /^\/api\/tools\/([a-z_]+)$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      if (!authorized(req.headers.authorization, token)) {
        return send(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Brak lub niepoprawny token workera.' } });
      }
      const name = m[1] as ToolName;
      if (!TOOL_NAMES.includes(name)) return send(res, 404, { ok: false, error: { code: 'unknown_tool', message: `Nieznane narzędzie: ${name}` } });
      let args: unknown;
      try {
        args = await readJson(req);
      } catch (e) {
        return send(res, 400, { ok: false, error: { code: 'invalid_json', message: e instanceof Error ? e.message : 'Niepoprawny JSON.' } });
      }
      const outcome = await runTool(service, name, args, log);
      return send(res, 200, outcome);
    }

    send(res, 404, { ok: false, error: { code: 'not_found', message: 'Nie znaleziono.' } });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, () => resolve());
  });
  const actual = (server.address() as AddressInfo).port;
  log.info('Lokalne API workera nasłuchuje', { url: `http://${LOOPBACK_HOST}:${actual}` });
  return {
    server,
    port: actual,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function runTool(service: LinkedInService, name: ToolName, args: unknown, log: Logger): Promise<ToolOutcome> {
  try {
    return { ok: true, result: await invokeOnService(service, name, args) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, error: e.toJSON() };
    log.error('Błąd narzędzia', { tool: name, error: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: { code: 'internal_error', message: 'Wewnętrzny błąd serwera. Szczegóły w worker.log.' } };
  }
}

function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `${LOOPBACK_HOST}:${port}` || host === `localhost:${port}`;
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  return tokensEqual(header.slice(7).trim(), token);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Za duże żądanie.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Niepoprawny JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
