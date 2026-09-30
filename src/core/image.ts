import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Obrazy w postach. Format rozpoznajemy po nagłówku pliku (nie po rozszerzeniu), więc przez
 * image_path nie da się "przemycić" dowolnego pliku z dysku. Przy podglądzie plik jest kopiowany
 * do katalogu danych (images/<sha256>.<ext>) - zatwierdzenie i publikacja używają tej kopii,
 * więc późniejsza zmiana lub usunięcie oryginału nie zmienia tego, co zostało zatwierdzone.
 */

export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export interface DetectedImage {
  mime: ImageMime;
  ext: 'jpg' | 'png' | 'gif';
  width: number | null;
  height: number | null;
}

export interface PostImage {
  /** Kopia w katalogu danych. */
  file: string;
  originalName: string;
  sha256: string;
  mime: ImageMime;
  bytes: number;
  width: number | null;
  height: number | null;
  alt: string;
}

export class ImageError extends Error {
  override name = 'ImageError';
  constructor(
    readonly code: 'image_not_found' | 'image_not_file' | 'image_unsupported' | 'image_too_large' | 'image_path_not_absolute' | 'image_empty',
    message: string,
  ) {
    super(message);
  }
}

export function detectImage(buf: Buffer): DetectedImage | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { mime: 'image/gif', ext: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', ...jpegSize(buf) };
  }
  return null;
}

function jpegSize(buf: Buffer): { width: number | null; height: number | null } {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return { width: null, height: null };
}

/** Sprawdza plik i kopiuje go do katalogu obrazów (adresowanie treścią - te same pliki się nie dublują). */
export function stageImage(sourcePath: string, imagesDir: string, maxBytes: number, alt: string): PostImage {
  const p = sourcePath.trim().replace(/^"(.*)"$/, '$1');
  if (!path.isAbsolute(p)) {
    throw new ImageError('image_path_not_absolute', `Ścieżka obrazu musi być pełna (np. C:\\Users\\...\\grafika.png), podano: ${sourcePath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    throw new ImageError('image_not_found', `Nie znaleziono pliku obrazu: ${p}`);
  }
  if (!stat.isFile()) throw new ImageError('image_not_file', `To nie jest plik: ${p}`);
  if (stat.size === 0) throw new ImageError('image_empty', `Plik obrazu jest pusty: ${p}`);
  if (stat.size > maxBytes) {
    throw new ImageError('image_too_large', `Obraz ma ${(stat.size / 1_048_576).toFixed(1)} MB - limit to ${(maxBytes / 1_048_576).toFixed(0)} MB.`);
  }
  const buf = fs.readFileSync(p);
  const det = detectImage(buf);
  if (!det) throw new ImageError('image_unsupported', `Nieobsługiwany format pliku ${path.basename(p)} - dozwolone: JPG, PNG, GIF.`);

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  fs.mkdirSync(imagesDir, { recursive: true });
  const file = path.join(imagesDir, `${sha256}.${det.ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return { file, originalName: path.basename(p), sha256, mime: det.mime, bytes: buf.length, width: det.width, height: det.height, alt };
}

/** Czy zatwierdzona kopia nadal istnieje i ma tę samą treść. */
export function verifyStagedImage(img: PostImage): boolean {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(img.file)).digest('hex') === img.sha256;
  } catch {
    return false;
  }
}
