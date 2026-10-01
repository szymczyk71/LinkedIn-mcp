import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Logger } from '../core/logger.js';
import { LinkedInService } from '../core/service.js';
import { registerTools } from '../mcp/tools.js';
import { BodyTooLarge, json, readBody } from '../web/html.js';
import { runTool } from '../worker/api.js';
import type { ServerCore } from './core.js';
import { OAuthServer } from './oauth-server.js';
import { UploadPages } from './upload-pages.js';

export const SERVER_VERSION = '0.6.0';

export interface HttpApp {
  server: http.Server;
  port: number;
  oauth: OAuthServer;
  close(): Promise<void>;
}

/** Prosty limit zapytań: okno 60 s na adres IP (+ osobny, ciaśniejszy limit dla endpointów OAuth). */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly perMin: number) {}
  allow(key: string, now = Date.now()): boolean {
    const from = now - 60_000;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > from);
    if (arr.length >= this.perMin) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((t) => t > from)) this.hits.delete(k);
    return true;
  }
}

/** Adres klienta: za bramą Azure Container Apps ostatni wpis X-Forwarded-For dodaje brama. */
function clientIp(req: http.IncomingMessage): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '');
  const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.at(-1) ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Wariant server-http: MCP (Streamable HTTP, bezstanowo) pod /mcp chroniony OAuth, serwer autoryzacji,
 * strona przesyłania zdjęć i health check - w jednym procesie z harmonogramem.
 */
export async function startHttpApp(core: ServerCore, log: Logger, opts: { port?: number; host?: string; fetchImpl?: typeof fetch } = {}): Promise<HttpApp> {
  const oauth = new OAuthServer(core, log, opts.fetchImpl);
  const uploads = new UploadPages(core, log);
  const limiter = new RateLimiter(core.config.http.rateLimitPerMin);
  const authLimiter = new RateLimiter(Math.max(10, Math.floor(core.config.http.rateLimitPerMin / 4)));

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log.error('Błąd HTTP', { path: req.url, error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', core.publicBaseUrl);
    const ip = clientIp(req);
    res.setHeader('x-content-type-options', 'nosniff');

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, service: 'linkedin-mcp-server', version: SERVER_VERSION, mode: core.config.mode });
    }

    const isAuth = ['/register', '/token', '/authorize', '/authorize/continue', '/oauth/callback'].includes(url.pathname);
    if (!(isAuth ? authLimiter : limiter).allow(`${isAuth ? 'a' : 'g'}:${ip}`)) {
      return json(res, 429, { error: 'rate_limited', error_description: 'Za dużo zapytań - spróbuj za chwilę.' }, { 'retry-after': '60' });
    }

    if (await oauth.handle(req, res, url)) return;
    if (await uploads.handle(req, res, url)) return;

    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        return res.end();
      }
      const token = await oauth.verifyBearer(req.headers.authorization);
      if (!token) return oauth.unauthorized(res);
      const user = await core.db.getUser(token.personUrn);
      // Każde zapytanie działa w imieniu zalogowanego administratora (autorstwo postów, audyt).
      const service = new LinkedInService(core, 'mcp', { personUrn: token.personUrn, name: user?.name ?? null });
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req, 2_000_000)).toString('utf8'));
      } catch (e) {
        return json(res, e instanceof BodyTooLarge ? 413 : 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      }
      // Tryb bezstanowy: nowy serwer MCP i transport na każde zapytanie.
      const mcp = new McpServer({ name: 'linkedin-mcp', version: SERVER_VERSION });
      registerTools(mcp, (name, args) => runTool(service, name, args, log));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (url.pathname === '/' && req.method === 'GET') {
      return json(res, 200, { service: 'linkedin-mcp-server', mcp: `${core.publicBaseUrl}/mcp` });
    }
    json(res, 404, { error: 'not_found' });
  }

  const host = opts.host ?? core.config.http.host;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? core.config.http.port, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  log.info('server-http nasłuchuje', { host, port, publicBaseUrl: core.publicBaseUrl, mcp: `${core.publicBaseUrl}/mcp` });
  return { server, port, oauth, close: () => new Promise<void>((r) => server.close(() => r())) };
}
