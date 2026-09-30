import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Lokalna atrapa serwerów LinkedIn (API + OAuth) do testów klienta live. Nic nie wychodzi do internetu. */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json?: any;
}

export type Behavior = 'ok' | 'hang' | 'destroy' | number;

export class FakeLinkedInServer {
  readonly requests: RecordedRequest[] = [];
  behavior: { posts: Behavior; comments: Behavior; images: Behavior; upload: Behavior; imageStatus: 'AVAILABLE' | 'PROCESSING' | 403; postsNoHeader: boolean } = {
    posts: 'ok',
    comments: 'ok',
    images: 'ok',
    upload: 'ok',
    imageStatus: 'AVAILABLE',
    postsNoHeader: false,
  };
  accessToken = 'AQV_fake_access_token_' + 'x'.repeat(60);
  sub = 'abcSUB123';
  name = 'Szymon Warda';
  private server!: http.Server;
  private sockets = new Set<import('node:net').Socket>();
  port = 0;
  private n = 0;

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => this.route(req, res, Buffer.concat(chunks)));
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
  }

  count(method: string, prefix: string): number {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix)).length;
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) {
    const url = new URL(req.url ?? '/', this.base);
    const rec: RecordedRequest = { method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body };
    try {
      rec.json = body.length && String(req.headers['content-type']).includes('json') ? JSON.parse(body.toString('utf8')) : undefined;
    } catch {
      /* nie JSON */
    }
    this.requests.push(rec);
    const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    const apply = (b: Behavior): boolean => {
      if (b === 'hang') return true;
      if (b === 'destroy') {
        req.socket.destroy();
        return true;
      }
      if (typeof b === 'number') {
        json(b, { status: b, message: `fake error ${b}`, code: 'FAKE' });
        return true;
      }
      return false;
    };
    const authed = req.headers.authorization === `Bearer ${this.accessToken}`;

    // --- OAuth ---
    if (req.method === 'POST' && url.pathname === '/oauth/v2/accessToken') {
      const p = new URLSearchParams(body.toString('utf8'));
      if (p.get('code') !== 'good-code') return json(400, { error: 'invalid_request', error_description: 'authorization code not found' });
      return json(200, { access_token: this.accessToken, expires_in: 5_184_000, scope: 'openid,profile,w_member_social' });
    }
    if (req.method === 'GET' && url.pathname === '/v2/userinfo') {
      if (!authed) return json(401, { message: 'invalid token' });
      return json(200, { sub: this.sub, name: this.name, given_name: 'Szymon', family_name: 'Warda' });
    }
    if (!authed && !url.pathname.startsWith('/upload/')) return json(401, { message: 'EMPTY_ACCESS_TOKEN' });

    // --- API ---
    if (req.method === 'POST' && url.pathname === '/rest/posts') {
      if (apply(this.behavior.posts)) return;
      const id = `urn:li:share:${7000000000000000000 + ++this.n}`;
      res.writeHead(201, this.behavior.postsNoHeader ? {} : { 'x-restli-id': id });
      return res.end();
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/rest/posts/')) {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/rest/images' && url.searchParams.get('action') === 'initializeUpload') {
      if (apply(this.behavior.images)) return;
      const id = `C4E10AQFake${++this.n}`;
      return json(200, { value: { uploadUrl: `${this.base}/upload/${id}`, image: `urn:li:image:${id}`, uploadUrlExpiresAt: Date.now() + 3600_000 } });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      if (!authed) return json(401, { message: 'upload requires token' });
      if (apply(this.behavior.upload)) return;
      res.writeHead(201);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname.startsWith('/rest/images/')) {
      if (this.behavior.imageStatus === 403) return json(403, { message: 'forbidden', status: 403 });
      return json(200, { id: decodeURIComponent(url.pathname.split('/').pop()!), status: this.behavior.imageStatus });
    }
    const cm = /^\/rest\/socialActions\/([^/]+)\/comments$/.exec(url.pathname);
    if (req.method === 'POST' && cm) {
      if (apply(this.behavior.comments)) return;
      const cid = String(6600000000000000000 + ++this.n);
      const postUrn = decodeURIComponent(cm[1]!);
      return json(201, { id: cid, commentUrn: `urn:li:comment:(${postUrn},${cid})`, object: postUrn }, { 'x-restli-id': cid });
    }
    json(404, { message: 'not found in fake' });
  }
}
