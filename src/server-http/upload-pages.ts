import type http from 'node:http';
import { ImageError, sha256Hex } from '../core/image.js';
import type { Logger } from '../core/logger.js';
import { formatLocal } from '../core/time.js';
import { BodyTooLarge, esc, json, page, readBody, scriptPage } from '../web/html.js';
import type { ServerCore } from './core.js';

/**
 * Jednorazowa strona przesyłania zdjęcia: GET /upload/<token> (formularz), PUT /upload/<token> (treść pliku).
 * Token z linku jest jedynym uprawnieniem - w bazie trzymamy tylko jego skrót. Po przesłaniu link przestaje działać.
 */
export class UploadPages {
  constructor(
    private readonly core: ServerCore,
    private readonly log: Logger,
  ) {}

  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const m = /^\/upload\/([A-Za-z0-9_-]{20,64})$/.exec(url.pathname);
    if (!m) return false;
    const token = m[1]!;
    const ticket = await this.core.db.getUploadByTokenHash(sha256Hex(Buffer.from(token)));
    const now = this.core.clock.now().toISOString();
    const tz = this.core.config.defaultTimezone;
    const maxMb = Math.round(this.core.config.imageMaxBytes / 1_048_576);

    if (req.method === 'GET') {
      if (!ticket) return page(res, 404, 'Link nieważny', '<p>Ten link do przesłania zdjęcia nie istnieje. Poproś Claude’a o nowy.</p>'), true;
      if (ticket.status === 'done') return page(res, 410, 'Zdjęcie już przesłane', `<p class="ok">Zdjęcie <code>${esc(ticket.id)}</code> zostało już przesłane. Wróć do rozmowy z Claude.</p>`), true;
      if (ticket.expiresAt <= now) return page(res, 410, 'Link wygasł', '<p>Link był ważny 15 minut. Poproś Claude’a o nowy.</p>'), true;
      scriptPage(
        res,
        200,
        'Zdjęcie do posta LinkedIn',
        `<p>Wybierz zdjęcie (JPG, PNG lub GIF, do ${maxMb} MB). Link jest ważny do <b>${esc(formatLocal(ticket.expiresAt, tz))}</b>.</p>
         <p><input id="f" type="file" accept="image/jpeg,image/png,image/gif"></p>
         <p><button id="b" class="btn" disabled>Wyślij zdjęcie</button></p>
         <p id="s" class="muted"></p><img id="p" class="thumb" alt="" hidden>`,
        `const f=document.getElementById('f'),b=document.getElementById('b'),s=document.getElementById('s'),p=document.getElementById('p');
f.onchange=()=>{const x=f.files[0];b.disabled=!x;if(x){p.src=URL.createObjectURL(x);p.hidden=false;s.textContent=x.name+' ('+(x.size/1048576).toFixed(1)+' MB)';}};
b.onclick=async()=>{const x=f.files[0];if(!x)return;b.disabled=true;s.textContent='Wysyłanie…';
try{const r=await fetch(location.pathname,{method:'PUT',headers:{'content-type':x.type||'application/octet-stream','x-file-name':encodeURIComponent(x.name)},body:x});
const j=await r.json();if(r.ok){s.className='ok';s.textContent='Gotowe! Zdjęcie '+j.image_id+' ('+j.width+'×'+j.height+'). Wróć do Claude i napisz „wysłane”.';f.disabled=true;}
else{s.className='err';s.textContent=j.error||'Błąd przesyłania.';b.disabled=false;}}catch(e){s.className='err';s.textContent='Błąd połączenia.';b.disabled=false;}};`,
      );
      return true;
    }

    if (req.method === 'PUT') {
      if (!ticket || ticket.status !== 'pending' || ticket.expiresAt <= now) {
        json(res, 410, { error: 'Link nieważny, wygasł albo zdjęcie już przesłano. Poproś Claude’a o nowy.' });
        return true;
      }
      let buf: Buffer;
      try {
        buf = await readBody(req, this.core.config.imageMaxBytes + 1);
      } catch (e) {
        json(res, e instanceof BodyTooLarge ? 413 : 400, { error: e instanceof BodyTooLarge ? `Plik większy niż ${maxMb} MB.` : 'Błąd odczytu pliku.' });
        return true;
      }
      const rawName = String(req.headers['x-file-name'] ?? 'zdjecie');
      let name: string;
      try {
        name = decodeURIComponent(rawName).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'zdjecie';
      } catch {
        name = 'zdjecie';
      }
      try {
        const img = await this.core.images.put(buf, name, this.core.config.imageMaxBytes, '');
        const ok = await this.core.db.completeUpload(ticket.id, img.sha256, name, this.core.clock.now().toISOString());
        if (!ok) {
          json(res, 410, { error: 'Link wygasł albo zdjęcie już przesłano.' });
          return true;
        }
        await this.core.audit.record('mcp', 'image_uploaded', 'ok', ticket.id, { bytes: img.bytes, mime: img.mime, width: img.width, height: img.height });
        this.log.info('Przesłano zdjęcie', { imageId: ticket.id, bytes: img.bytes });
        json(res, 200, { image_id: ticket.id, mime: img.mime, bytes: img.bytes, width: img.width, height: img.height });
      } catch (e) {
        if (e instanceof ImageError) json(res, 400, { error: e.message });
        else {
          this.log.error('Błąd zapisu zdjęcia', { error: e instanceof Error ? e.message : String(e) });
          json(res, 500, { error: 'Nie udało się zapisać zdjęcia.' });
        }
      }
      return true;
    }
    res.writeHead(405, { allow: 'GET, PUT' });
    res.end();
    return true;
  }
}
