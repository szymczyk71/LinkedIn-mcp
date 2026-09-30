import crypto from 'node:crypto';
import type http from 'node:http';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STYLE = `body{font-family:Segoe UI,system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5;color:#1b1b1b}
code{background:#eee;padding:1px 4px;border-radius:3px}.btn{display:inline-block;background:#0a66c2;color:#fff;padding:12px 20px;border-radius:24px;text-decoration:none;border:0;font-size:16px;cursor:pointer}
.muted{color:#666;font-size:14px}.ok{color:#0a7a2f}.err{color:#b00020}img.thumb{max-width:100%;max-height:320px;border-radius:8px;margin-top:12px}`;

/** Strona HTML bez skryptów (CSP blokuje wszystko poza stylem inline). */
export function page(res: http.ServerResponse, status: number, title: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; form-action 'self' https://www.linkedin.com; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(shell(title, body));
}

/** Strona ze skryptem inline dopuszczonym przez nonce. */
export function scriptPage(res: http.ServerResponse, status: number, title: string, body: string, script: string): void {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'`,
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(shell(title, `${body}<script nonce="${nonce}">${script}</script>`));
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export class BodyTooLarge extends Error {}

export function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new BodyTooLarge('Za duże żądanie.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
