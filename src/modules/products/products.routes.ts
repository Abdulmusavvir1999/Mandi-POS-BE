import { Router } from 'express';
import { ProductsController } from './products.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';
import { validateBody } from '../../core/middleware/validate.middleware';
import { createProductSchema } from '../../core/validation/common.validation';

const router = Router();

// Add-ons
router.get('/addons', authenticate, ProductsController.getAddons);
router.get('/addons/:id', authenticate, ProductsController.getAddonById);
router.post('/addons', authenticate, requirePermission('product.manage'), ProductsController.createAddon);
router.put('/addons/:id', authenticate, requirePermission('product.manage'), ProductsController.updateAddon);
router.delete('/addons/:id', authenticate, requirePermission('product.manage'), ProductsController.deleteAddon);

// Combos
router.get('/combos', authenticate, ProductsController.getCombos);
router.get('/combos/:id', authenticate, ProductsController.getComboById);
router.post('/combos', authenticate, requirePermission('product.manage'), ProductsController.createCombo);
router.put('/combos/:id', authenticate, requirePermission('product.manage'), ProductsController.updateCombo);
router.delete('/combos/:id', authenticate, requirePermission('product.manage'), ProductsController.deleteCombo);

// Deals
router.get('/deals', authenticate, ProductsController.getDeals);
router.get('/deals/:id', authenticate, ProductsController.getDealById);
router.post('/deals', authenticate, requirePermission('product.manage'), ProductsController.createDeal);
router.put('/deals/:id', authenticate, requirePermission('product.manage'), ProductsController.updateDeal);
router.delete('/deals/:id', authenticate, requirePermission('product.manage'), ProductsController.deleteDeal);

// Products
router.get('/', authenticate, ProductsController.getAll);
router.get('/:id/addons', authenticate, ProductsController.getProductAddons);
router.get('/:id', authenticate, ProductsController.getById);
router.post('/image', authenticate, requirePermission('product.manage'), ProductsController.uploadImage);
router.post('/', authenticate, requirePermission('product.manage'), validateBody(createProductSchema), ProductsController.create);
router.put('/:id', authenticate, requirePermission('product.manage'), ProductsController.update);
router.delete('/:id', authenticate, requirePermission('product.manage'), ProductsController.delete);

export default router;
