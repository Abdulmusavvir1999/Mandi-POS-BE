import fs from 'fs';
import path from 'path';
import { AppError } from '../../core/errors/AppError';

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

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

// A declared MIME type is only a claim by the browser, so the bytes have to
// agree before anything is written under a folder the server hands out.
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 6).toString('ascii').startsWith('GIF8'),
  'image/webp': (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  'image/x-icon': (b) => b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00,
};
SIGNATURES['image/vnd.microsoft.icon'] = SIGNATURES['image/x-icon'];

// src/modules/settings and dist/modules/settings are both three levels down
// from the backend root, so the folder is the same either way.
export const UPLOAD_ROOT = path.resolve(__dirname, '..', '..', '..', 'uploads');
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
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      throw AppError.badRequest('Image must be sent as a base64 data URL.', 'BRANDING_PAYLOAD_INVALID');
    }

    const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(dataUrl);
    if (!match) throw AppError.badRequest('Image data URL is malformed.', 'BRANDING_PAYLOAD_INVALID');

    const mime = match[1].toLowerCase();
    if (!spec.types.includes(mime)) {
      throw AppError.badRequest(
        `${spec.label} must be one of: ${[...new Set(spec.types.map((t) => EXTENSIONS[t]))].join(', ')}.`,
        'BRANDING_TYPE_INVALID'
      );
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length) throw AppError.badRequest(`${spec.label} is empty.`, 'BRANDING_PAYLOAD_INVALID');
    if (buffer.length > spec.maxBytes) {
      throw AppError.badRequest(
        `${spec.label} is ${(buffer.length / 1024 / 1024).toFixed(1)} MB - the limit is ${spec.maxBytes / 1024 / 1024} MB.`,
        'BRANDING_TOO_LARGE'
      );
    }

    const verify = SIGNATURES[mime];
    if (verify && !verify(buffer)) {
      throw AppError.badRequest(`${spec.label} is not a valid ${EXTENSIONS[mime]} image.`, 'BRANDING_TYPE_INVALID');
    }

    fs.mkdirSync(BRANDING_DIR, { recursive: true });

    // The name is generated, never taken from the client, and the timestamp
    // busts the browser cache on the favicon and the login hero.
    const fileName = `${slot}-${Date.now()}.${EXTENSIONS[mime]}`;
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
