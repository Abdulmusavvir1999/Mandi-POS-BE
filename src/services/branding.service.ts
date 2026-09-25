import fs from 'fs';
import path from 'path';
import { AppError } from '../errors/AppError';
import { decodeImageDataUrl, UPLOAD_ROOT } from '../utils/image-upload.util';

export { UPLOAD_ROOT };

/** Branding images the Store settings tab can replace. */
export type BrandingSlot = 'login' | 'favicon' | 'logo';

/**
 * Uploads arrive as data URLs on the JSON body rather than as multipart form
 * data - it keeps the upload on the same express.json() pipeline (and the same
 * auth middleware) as every other settings write, with no extra dependency.
 */
interface BrandingUpload {
  slot: BrandingSlot;
  dataUrl: string;
}

const SLOTS: Record<BrandingSlot, { label: string; maxBytes: number; types: string[] }> = {
  logo: {
    label: 'Brand logo',
    maxBytes: 2 * 1024 * 1024,
    types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
  login: {
    label: 'Login image',
    maxBytes: 5 * 1024 * 1024,
    types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
  favicon: {
    label: 'Favicon',
    maxBytes: 1 * 1024 * 1024,
    types: ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/webp', 'image/gif'],
  },
};

const BRANDING_DIR = path.join(UPLOAD_ROOT, 'branding');

/** Public path of a stored file - saved in settings, resolved against the API host by the client. */
const publicPath = (fileName: string) => `/uploads/branding/${fileName}`;

export class BrandingService {
  /**
   * Decodes a data URL into `uploads/branding/` and returns the URL to store.
   * Older files for the same slot are removed, so replacing the login image a
   * dozen times does not leave a dozen orphans behind.
   */
  static save({ slot, dataUrl }: BrandingUpload): { url: string; fileName: string; bytes: number } {
    const spec = SLOTS[slot];
    if (!spec) throw AppError.badRequest(`Unknown branding slot "${slot}".`, 'BRANDING_SLOT_INVALID');
    const { buffer, ext } = decodeImageDataUrl(dataUrl, spec, 'BRANDING');

    fs.mkdirSync(BRANDING_DIR, { recursive: true });

    // The name is generated, never taken from the client, and the timestamp
    // busts the browser cache on the favicon and the login hero.
    const fileName = `${slot}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(BRANDING_DIR, fileName), buffer);
    this.purgeOlderThan(slot, fileName);

    console.log(`🖼️  [BRANDING UPLOAD] ${spec.label} saved as ${fileName} (${(buffer.length / 1024).toFixed(0)} KB)`);
    return { url: publicPath(fileName), fileName, bytes: buffer.length };
  }

  private static purgeOlderThan(slot: BrandingSlot, keep: string): void {
    try {
      for (const entry of fs.readdirSync(BRANDING_DIR)) {
        if (entry !== keep && entry.startsWith(`${slot}-`)) {
          fs.unlinkSync(path.join(BRANDING_DIR, entry));
        }
      }
    } catch (_) {
      /* a leftover file is harmless - never fail the upload over it */
    }
  }
}
