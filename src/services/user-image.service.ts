import { createImageStore, imageSpec } from '../utils/image-store';

/** Staff images: one file per row under uploads/users/. */
export const UserImageService = createImageStore({
  folder: 'users',
  prefix: 'user',
  code: 'USER_IMAGE',
  spec: imageSpec('Staff photo'),
});
