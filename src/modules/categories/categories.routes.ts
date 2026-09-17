import { Router } from 'express';
import { CategoriesController } from './categories.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';
import { validateBody } from '../../core/middleware/validate.middleware';
import { createCategorySchema } from '../../core/validation/common.validation';

const router = Router();

router.get('/', authenticate, CategoriesController.getAll);
router.get('/:id', authenticate, CategoriesController.getById);
router.post('/image', authenticate, requirePermission('category.manage'), CategoriesController.uploadImage);
router.post('/', authenticate, requirePermission('category.manage'), validateBody(createCategorySchema), CategoriesController.create);
router.put('/:id', authenticate, requirePermission('category.manage'), CategoriesController.update);
router.delete('/:id', authenticate, requirePermission('category.manage'), CategoriesController.delete);

export default router;
