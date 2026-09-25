import { Router } from 'express';
import { ProductsController } from '../controllers/products.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { createProductSchema } from '../validations/common.validation';

const router = Router();

// Add-ons
router.get('/addons', authenticate, ProductsController.getAddons);
router.get('/addons/:id', authenticate, ProductsController.getAddonById);
router.post('/addons', authenticate, requirePermission('product.manage'), ProductsController.createAddon);
router.put('/addons/:id', authenticate, requirePermission('product.manage'), ProductsController.updateAddon);
router.delete('/addons/:id', authenticate, requirePermission('product.manage'), ProductsController.deleteAddon);

// Combo Deals — the one bundle type. Meal Deals were withdrawn.
router.get('/combo-deals', authenticate, ProductsController.getComboDeals);
router.get('/combo-deals/:id', authenticate, ProductsController.getComboDealById);
router.post('/combo-deals', authenticate, requirePermission('product.manage'), ProductsController.createComboDeal);
router.put('/combo-deals/:id', authenticate, requirePermission('product.manage'), ProductsController.updateComboDeal);
router.delete('/combo-deals/:id', authenticate, requirePermission('product.manage'), ProductsController.deleteComboDeal);

// Products
router.get('/', authenticate, ProductsController.getAll);
router.get('/:id/addons', authenticate, ProductsController.getProductAddons);
router.get('/:id', authenticate, ProductsController.getById);
router.post('/image', authenticate, requirePermission('product.manage'), ProductsController.uploadImage);
router.post('/', authenticate, requirePermission('product.manage'), validateBody(createProductSchema), ProductsController.create);
router.put('/:id', authenticate, requirePermission('product.manage'), ProductsController.update);
router.delete('/:id', authenticate, requirePermission('product.manage'), ProductsController.delete);

export default router;
