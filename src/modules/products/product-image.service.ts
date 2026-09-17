import fs from 'fs';
import path from 'path';
import { decodeImageDataUrl, resolveUploadPath, UPLOAD_ROOT, ImageSpec } from '../../core/utils/image-upload.util';

/**
 * Dish photos. Same shape as the category store — one file per product row,
 * random suffix, previous file removed only when the row stops pointing at it.
 * All of the validation that matters lives in decodeImageDataUrl.
 */

const SPEC: ImageSpec = {
  label: 'Dish image',
  maxBytes: 2 * 1024 * 1024,
  types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
};

const PRODUCT_DIR = path.join(UPLOAD_ROOT, 'products');
const PUBLIC_PREFIX = '/uploads/products/';

export class ProductImageService {
  static save(dataUrl: string): { url: string; fileName: string; bytes: number } {
    const { buffer, ext } = decodeImageDataUrl(dataUrl, SPEC, 'PRODUCT_IMAGE');

    fs.mkdirSync(PRODUCT_DIR, { recursive: true });

    const fileName = `product-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(PRODUCT_DIR, fileName), buffer);

    console.log(`🖼️  [PRODUCT IMAGE] saved as ${fileName} (${(buffer.length / 1024).toFixed(0)} KB)`);
    return { url: `${PUBLIC_PREFIX}${fileName}`, fileName, bytes: buffer.length };
  }

  /** Deletes the file a stored URL points at; never throws. */
  static removeByUrl(publicUrl: string | null | undefined): void {
    try {
      const target = resolveUploadPath(publicUrl, PUBLIC_PREFIX, PRODUCT_DIR);
      if (target && fs.existsSync(target)) {
        fs.unlinkSync(target);
        console.log(`🗑️  [PRODUCT IMAGE] removed ${path.basename(target)}`);
      }
    } catch (_) {
      /* never fail a product write over a leftover file */
    }
  }
}
