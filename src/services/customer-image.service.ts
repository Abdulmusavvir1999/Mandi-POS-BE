import { createImageStore, imageSpec } from '../utils/image-store';

/** Customer images: one file per row under uploads/customers/. */
export const CustomerImageService = createImageStore({
  folder: 'customers',
  prefix: 'customer',
  code: 'CUSTOMER_IMAGE',
  spec: imageSpec('Customer photo'),
});
