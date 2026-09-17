import path from 'path';
import { AppError } from '../errors/AppError';

/**
 * Shared decoding and validation for images that arrive as base64 data URLs on
 * a JSON body. Keeping this in one place means branding uploads and category
 * images cannot drift apart on the checks that matter — a hole in a second
 * copy of the magic-byte test is exactly how an upload folder gets poisoned.
 */

// src/core/utils, src/modules/settings and their dist equivalents are all
// three levels below the backend root, so this resolves the same either way.
export const UPLOAD_ROOT = path.resolve(__dirname, '..', '..', '..', 'uploads');

export const IMAGE_EXTENSIONS: Record<string, string> = {
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

export interface ImageSpec {
  /** Human name used in error messages, e.g. "Category image". */
  label: string;
  maxBytes: number;
  types: string[];
}

export interface DecodedImage {
  buffer: Buffer;
  mime: string;
  ext: string;
}

/**
 * Validates a base64 data URL and returns its bytes. Throws AppError.badRequest
 * with `<codePrefix>_*` codes so each caller keeps its own error vocabulary.
 */
export function decodeImageDataUrl(dataUrl: string, spec: ImageSpec, codePrefix: string): DecodedImage {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw AppError.badRequest('Image must be sent as a base64 data URL.', `${codePrefix}_PAYLOAD_INVALID`);
  }

  const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw AppError.badRequest('Image data URL is malformed.', `${codePrefix}_PAYLOAD_INVALID`);

  const mime = match[1].toLowerCase();
  if (!spec.types.includes(mime)) {
    throw AppError.badRequest(
      `${spec.label} must be one of: ${[...new Set(spec.types.map((t) => IMAGE_EXTENSIONS[t]))].join(', ')}.`,
      `${codePrefix}_TYPE_INVALID`
    );
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw AppError.badRequest(`${spec.label} is empty.`, `${codePrefix}_PAYLOAD_INVALID`);
  if (buffer.length > spec.maxBytes) {
    throw AppError.badRequest(
      `${spec.label} is ${(buffer.length / 1024 / 1024).toFixed(1)} MB - the limit is ${spec.maxBytes / 1024 / 1024} MB.`,
      `${codePrefix}_TOO_LARGE`
    );
  }

  const verify = SIGNATURES[mime];
  if (verify && !verify(buffer)) {
    throw AppError.badRequest(`${spec.label} is not a valid ${IMAGE_EXTENSIONS[mime]} image.`, `${codePrefix}_TYPE_INVALID`);
  }

  return { buffer, mime, ext: IMAGE_EXTENSIONS[mime] };
}

/**
 * Resolves a stored public path such as `/uploads/categories/cat-123.png` back
 * to a file inside `dir`, or null when the value is not one of ours. The
 * basename is compared against itself so a crafted `../../` value can never
 * escape the folder being cleaned up.
 */
export function resolveUploadPath(publicUrl: string | null | undefined, publicPrefix: string, dir: string): string | null {
  if (!publicUrl || typeof publicUrl !== 'string') return null;
  if (!publicUrl.startsWith(publicPrefix)) return null;

  const fileName = publicUrl.slice(publicPrefix.length);
  if (!fileName || fileName !== path.basename(fileName)) return null;

  return path.join(dir, fileName);
}
