import { createImageStore, imageSpec } from '../../core/utils/image-store';

/** Vendor logos/images: one file per row under uploads/vendors/. */
export const VendorImageService = createImageStore({
  folder: 'vendors',
  prefix: 'vendor',
  code: 'VENDOR_IMAGE',
  spec: imageSpec('Vendor logo'),
});
