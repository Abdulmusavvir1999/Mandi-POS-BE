import { createImageStore, imageSpec } from '../../core/utils/image-store';

/** Category images: one file per row under uploads/categories/. */
export const CategoryImageService = createImageStore({
  folder: 'categories',
  prefix: 'category',
  code: 'CATEGORY_IMAGE',
  spec: imageSpec('Category image'),
});
