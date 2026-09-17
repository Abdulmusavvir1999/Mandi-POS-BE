import { createImageStore, imageSpec } from '../../core/utils/image-store';

/** Dish images: one file per row under uploads/products/. */
export const ProductImageService = createImageStore({
  folder: 'products',
  prefix: 'product',
  code: 'PRODUCT_IMAGE',
  spec: imageSpec('Dish image'),
});
