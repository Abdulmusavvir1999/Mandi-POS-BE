import fs from 'fs';
import path from 'path';
import { UPLOAD_ROOT } from '../settings/branding.service';
import { decodeImageDataUrl, resolveUploadPath, ImageSpec } from '../../core/utils/image-upload.util';

/**
 * Category thumbnails. Unlike branding slots there is one file per category
 * row, so files are named with a random suffix and the previous file is only
 * removed when the owning row actually points somewhere else.
 */

const SPEC: ImageSpec = {
  label: 'Category image',
  maxBytes: 2 * 1024 * 1024,
  types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
};

const CATEGORY_DIR = path.join(UPLOAD_ROOT, 'categories');
const PUBLIC_PREFIX = '/uploads/categories/';

export class CategoryImageService {
  /** Decodes a data URL into `uploads/categories/` and returns the URL to store. */
  static save(dataUrl: string): { url: string; fileName: string; bytes: number } {
    const { buffer, ext } = decodeImageDataUrl(dataUrl, SPEC, 'CATEGORY_IMAGE');

    fs.mkdirSync(CATEGORY_DIR, { recursive: true });

    // Generated server-side, never taken from the client.
    const fileName = `category-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(CATEGORY_DIR, fileName), buffer);

    console.log(`🖼️  [CATEGORY IMAGE] saved as ${fileName} (${(buffer.length / 1024).toFixed(0)} KB)`);
    return { url: `${PUBLIC_PREFIX}${fileName}`, fileName, bytes: buffer.length };
  }

  /**
   * Deletes the file a stored URL points at. Anything that is not one of our
   * own category uploads is ignored, and a failure never propagates — an
   * orphaned file is a far smaller problem than a failed category write.
   */
  static removeByUrl(publicUrl: string | null | undefined): void {
    try {
      const target = resolveUploadPath(publicUrl, PUBLIC_PREFIX, CATEGORY_DIR);
      if (target && fs.existsSync(target)) {
        fs.unlinkSync(target);
        console.log(`🗑️  [CATEGORY IMAGE] removed ${path.basename(target)}`);
      }
    } catch (_) {
      /* never fail a category write over a leftover file */
    }
  }
}
