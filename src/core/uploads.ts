import type { PostImage } from './image.js';

/**
 * Przesyłanie zdjęć przez jednorazowy link (server-http). Narzędzie linkedin_request_image_upload tworzy
 * bilet z identyfikatorem obrazu (img_...) i adresem strony do przesłania pliku; po przesłaniu identyfikator
 * można podać jako image_id w podglądzie.
 */
export interface ImageUploadTicket {
  imageId: string;
  uploadUrl: string;
  expiresAt: string;
}

export type UploadState =
  | { status: 'not_found' }
  | { status: 'pending'; expiresAt: string }
  | { status: 'expired' }
  | { status: 'done'; image: Omit<PostImage, 'alt'> };

export interface UploadRegistry {
  create(now: Date): Promise<ImageUploadTicket>;
  get(imageId: string, now: Date): Promise<UploadState>;
}
