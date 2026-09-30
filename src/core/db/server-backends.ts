import crypto from 'node:crypto';
import { validateImage, sha256Hex, type ImageRepo, type PostImage } from '../image.js';
import type { PauseBackend, PauseInfo } from '../pause.js';
import type { SecretBackend } from '../token-store.js';
import type { ImageUploadTicket, UploadRegistry, UploadState } from '../uploads.js';
import type { ServerData } from './server-data.js';

/** Obrazy w bazie (server-http). `PostImage.file` = "db:<sha256>". */
export class DbImageRepo implements ImageRepo {
  readonly kind = 'db' as const;
  constructor(private readonly db: ServerData) {}

  async put(buf: Buffer, originalName: string, maxBytes: number, alt: string): Promise<PostImage> {
    const v = validateImage(buf, originalName, maxBytes);
    await this.db.putImage({ sha256: v.sha256, mime: v.mime, data: buf, width: v.width, height: v.height, createdAt: new Date().toISOString() });
    return { file: `db:${v.sha256}`, originalName, sha256: v.sha256, mime: v.mime, bytes: buf.length, width: v.width, height: v.height, alt };
  }

  async read(img: PostImage): Promise<Buffer | null> {
    const row = await this.db.getImage(img.sha256);
    if (!row) return null;
    return sha256Hex(row.data) === img.sha256 ? row.data : null;
  }
}

export class DbSecret implements SecretBackend {
  constructor(
    private readonly db: ServerData,
    private readonly name: string,
  ) {}
  read(): Promise<string | null> {
    return this.db.getSecret(this.name);
  }
  write(value: string): Promise<void> {
    return this.db.setSecret(this.name, value, new Date().toISOString());
  }
  clear(): Promise<boolean> {
    return this.db.deleteSecret(this.name);
  }
}

export class DbPause implements PauseBackend {
  constructor(private readonly db: ServerData) {}
  async read(): Promise<PauseInfo> {
    const v = await this.db.getSetting('pause');
    if (!v) return { paused: false, since: null, reason: null };
    const j = JSON.parse(v) as { since?: string; reason?: string | null };
    return { paused: true, since: j.since ?? null, reason: j.reason ?? null };
  }
  async set(reason: string | null, now = new Date()): Promise<PauseInfo> {
    const info = { since: now.toISOString(), reason };
    await this.db.setSetting('pause', JSON.stringify(info), info.since);
    return { paused: true, ...info };
  }
  async clear(): Promise<PauseInfo> {
    await this.db.setSetting('pause', null, new Date().toISOString());
    return { paused: false, since: null, reason: null };
  }
}

export const UPLOAD_TTL_MIN = 15;

/** Jednorazowe linki do przesyłania zdjęć. W linku jest losowy token; w bazie tylko jego skrót. */
export class DbUploadRegistry implements UploadRegistry {
  constructor(
    private readonly db: ServerData,
    private readonly publicBaseUrl: string,
  ) {}

  async create(now: Date): Promise<ImageUploadTicket> {
    const token = crypto.randomBytes(24).toString('base64url');
    const imageId = `img_${crypto.randomBytes(9).toString('base64url')}`;
    const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MIN * 60_000).toISOString();
    await this.db.createUpload({
      id: imageId,
      tokenHash: sha256Hex(Buffer.from(token)),
      status: 'pending',
      imageSha256: null,
      originalName: null,
      createdAt: now.toISOString(),
      expiresAt,
    });
    return { imageId, uploadUrl: `${this.publicBaseUrl}/upload/${token}`, expiresAt };
  }

  async get(imageId: string, now: Date): Promise<UploadState> {
    const u = await this.db.getUpload(imageId);
    if (!u) return { status: 'not_found' };
    if (u.status === 'pending') return u.expiresAt <= now.toISOString() ? { status: 'expired' } : { status: 'pending', expiresAt: u.expiresAt };
    const img = await this.db.getImage(u.imageSha256!);
    if (!img) return { status: 'not_found' };
    return {
      status: 'done',
      image: {
        file: `db:${img.sha256}`,
        originalName: u.originalName ?? 'zdjecie',
        sha256: img.sha256,
        mime: img.mime as PostImage['mime'],
        bytes: img.data.length,
        width: img.width,
        height: img.height,
      },
    };
  }
}
