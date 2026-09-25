import fs from 'fs';
import path from 'path';
import { decodeImageDataUrl, resolveUploadPath, UPLOAD_ROOT, ImageSpec } from './image-upload.util';

/**
 * A folder under `uploads/` that holds one image per row of some table.
 *
 * Branding is slot-based (one file per slot, older ones purged); everything
 * else — categories, dishes, customers, staff — is row-based and differs only
 * in the folder, the filename prefix and the accepted types. That shape now
 * lives here once instead of being copy-pasted per module, so a fix to the
 * write or cleanup path cannot reach three of four call sites.
 */

export interface ImageStore {
  save(dataUrl: string): { url: string; fileName: string; bytes: number };
  removeByUrl(publicUrl: string | null | undefined): void;
}

export interface ImageStoreConfig {
  /** Folder under uploads/, also the public path segment. */
  folder: string;
  /** Filename prefix, e.g. "customer" -> customer-1712345678-ab12xy.png */
  prefix: string;
  /** Error-code prefix, e.g. "CUSTOMER_IMAGE" -> CUSTOMER_IMAGE_TOO_LARGE */
  code: string;
  spec: ImageSpec;
}

const DEFAULT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function imageSpec(label: string, maxMb = 2, types: string[] = DEFAULT_TYPES): ImageSpec {
  return { label, maxBytes: maxMb * 1024 * 1024, types };
}

export function createImageStore(config: ImageStoreConfig): ImageStore {
  const dir = path.join(UPLOAD_ROOT, config.folder);
  const publicPrefix = `/uploads/${config.folder}/`;

  return {
    save(dataUrl: string) {
      const { buffer, ext } = decodeImageDataUrl(dataUrl, config.spec, config.code);

      fs.mkdirSync(dir, { recursive: true });

      // Generated server-side, never taken from the client.
      const fileName = `${config.prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;
      fs.writeFileSync(path.join(dir, fileName), buffer);

      console.log(`🖼️  [${config.code}] saved as ${fileName} (${(buffer.length / 1024).toFixed(0)} KB)`);
      return { url: `${publicPrefix}${fileName}`, fileName, bytes: buffer.length };
    },

    /**
     * Deletes the file a stored URL points at. Anything that is not one of this
     * store's own uploads is ignored, and a failure never propagates — an
     * orphaned file is a far smaller problem than a failed write.
     */
    removeByUrl(publicUrl: string | null | undefined) {
      try {
        const target = resolveUploadPath(publicUrl, publicPrefix, dir);
        if (target && fs.existsSync(target)) {
          fs.unlinkSync(target);
          console.log(`🗑️  [${config.code}] removed ${path.basename(target)}`);
        }
      } catch (_) {
        /* never fail a write over a leftover file */
      }
    },
  };
}
