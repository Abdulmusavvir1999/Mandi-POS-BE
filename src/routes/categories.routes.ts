import { Router } from 'express';
import { CategoriesController } from '../controllers/categories.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { createCategorySchema } from '../validations/common.validation';

const router = Router();

router.get('/', authenticate, CategoriesController.getAll);
router.get('/:id', authenticate, CategoriesController.getById);
router.post('/image', authenticate, requirePermission('category.manage'), CategoriesController.uploadImage);
router.post('/', authenticate, requirePermission('category.manage'), validateBody(createCategorySchema), CategoriesController.create);
router.put('/:id', authenticate, requirePermission('category.manage'), CategoriesController.update);
router.delete('/:id', authenticate, requirePermission('category.manage'), CategoriesController.delete);

export default router;
