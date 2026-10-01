import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Lokalna atrapa serwerów LinkedIn (API + OAuth) do testów klienta live. Nic nie wychodzi do internetu. */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json?: any;
  /** Osoba, której token był w żądaniu (sub). */
  as?: string;
}

export type Behavior = 'ok' | 'hang' | 'destroy' | number;

export const ORG = 'urn:li:organization:1001';

export interface FakeUser {
  sub: string;
  name: string;
  token: string;
  /** Role na stronach firm (domyślnie stan APPROVED). */
  acls: { organization: string; role: string; state?: string }[];
  meForbidden?: boolean;
}

export class FakeLinkedInServer {
  readonly requests: RecordedRequest[] = [];
  behavior: {
    posts: Behavior;
    comments: Behavior;
    images: Behavior;
    upload: Behavior;
    imageStatus: 'AVAILABLE' | 'PROCESSING' | 403;
    postsNoHeader: boolean;
    /** Komentarz jako strona tylko z rolą ADMINISTRATOR (jak w dokumentacji Comments API). */
    commentsRequireAdmin: boolean;
    acls: Behavior;
  } = { posts: 'ok', comments: 'ok', images: 'ok', upload: 'ok', imageStatus: 'AVAILABLE', postsNoHeader: false, commentsRequireAdmin: true, acls: 'ok' };

  readonly users: FakeUser[] = [];
  private readonly codes = new Map<string, FakeUser>();
  private server!: http.Server;
  private sockets = new Set<import('node:net').Socket>();
  port = 0;
  private n = 0;

  constructor() {
    this.addUser({ sub: 'abcSUB123', name: 'Szymon Warda', roles: ['ADMINISTRATOR'], code: 'good-code' });
  }

  /** Pierwsza (domyślna) osoba - administrator strony ORG. */
  get accessToken(): string {
    return this.users[0]!.token;
  }
  get sub(): string {
    return this.users[0]!.sub;
  }
  get name(): string {
    return this.users[0]!.name;
  }

  /** Dodaje osobę z rolami na stronie ORG (albo dowolnymi acls); zwraca kod autoryzacji dla tej osoby. */
  addUser(u: { sub: string; name: string; roles?: string[]; acls?: FakeUser['acls']; code?: string; meForbidden?: boolean }): string {
    const user: FakeUser = {
      sub: u.sub,
      name: u.name,
      token: `AQV_${u.sub}_${crypto.randomBytes(30).toString('hex')}`,
      acls: u.acls ?? (u.roles ?? []).map((role) => ({ organization: ORG, role })),
      meForbidden: u.meForbidden,
    };
    this.users.push(user);
    const code = u.code ?? `code-${u.sub}`;
    this.codes.set(code, user);
    return code;
  }

  user(sub: string): FakeUser {
    return this.users.find((u) => u.sub === sub)!;
  }

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
    const caller = this.users.find((u) => req.headers.authorization === `Bearer ${u.token}`);
    const rec: RecordedRequest = { method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body, as: caller?.sub };
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

    // --- OAuth ---
    if (req.method === 'POST' && url.pathname === '/oauth/v2/accessToken') {
      const p = new URLSearchParams(body.toString('utf8'));
      const u = this.codes.get(p.get('code') ?? '');
      if (!u) return json(400, { error: 'invalid_request', error_description: 'authorization code not found' });
      return json(200, { access_token: u.token, expires_in: 5_184_000, scope: 'r_organization_admin,w_organization_social' });
    }
    if (!caller && !url.pathname.startsWith('/upload/')) return json(401, { message: 'EMPTY_ACCESS_TOKEN' });

    // --- tożsamość i role ---
    if (req.method === 'GET' && url.pathname === '/rest/organizationAcls' && url.searchParams.get('q') === 'roleAssignee') {
      if (apply(this.behavior.acls)) return;
      const state = url.searchParams.get('state');
      const elements = caller!.acls
        .map((a) => ({ role: a.role, organization: a.organization, roleAssignee: `urn:li:person:${caller!.sub}`, state: a.state ?? 'APPROVED' }))
        .filter((e) => !state || e.state === state);
      return json(200, { elements, paging: { count: 100, start: 0, links: [] } });
    }
    if (req.method === 'GET' && url.pathname === '/v2/me') {
      if (caller!.meForbidden) return json(403, { message: 'Not enough permissions to access: me.GET' });
      const [first, ...rest] = caller!.name.split(' ');
      return json(200, { id: caller!.sub, localizedFirstName: first, localizedLastName: rest.join(' ') });
    }

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
      if (!caller) return json(401, { message: 'upload requires token' });
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
      const actor = rec.json?.actor as string | undefined;
      if (this.behavior.commentsRequireAdmin && actor?.startsWith('urn:li:organization:') && !caller!.acls.some((a) => a.organization === actor && a.role === 'ADMINISTRATOR')) {
        return json(403, { message: 'Not enough permissions to comment as organization', status: 403 });
      }
      const cid = String(6600000000000000000 + ++this.n);
      const postUrn = decodeURIComponent(cm[1]!);
      return json(201, { id: cid, commentUrn: `urn:li:comment:(${postUrn},${cid})`, object: postUrn }, { 'x-restli-id': cid });
    }
    json(404, { message: 'not found in fake' });
  }
}
