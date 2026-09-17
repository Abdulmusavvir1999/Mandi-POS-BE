import { Router } from 'express';
import { ProductsController } from './products.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';
import { validateBody } from '../../core/middleware/validate.middleware';
import { createProductSchema } from '../../core/validation/common.validation';

const router = Router();

router.get('/', authenticate, ProductsController.getAll);
router.get('/:id', authenticate, ProductsController.getById);
router.post('/image', authenticate, requirePermission('product.manage'), ProductsController.uploadImage);
router.post('/', authenticate, requirePermission('product.manage'), validateBody(createProductSchema), ProductsController.create);
router.put('/:id', authenticate, requirePermission('product.manage'), ProductsController.update);
router.delete('/:id', authenticate, requirePermission('product.manage'), ProductsController.delete);

export default router;
