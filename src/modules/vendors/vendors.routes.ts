import { Router } from 'express';
import { VendorsController } from './vendors.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

// Stats summary
router.get('/stats', authenticate, VendorsController.getStats);

// Listing and details
router.get('/', authenticate, VendorsController.getAll);
router.get('/:id', authenticate, VendorsController.getById);

// Purchase History & Recording
router.get('/:id/purchases', authenticate, VendorsController.getPurchases);
router.post('/:id/purchases', authenticate, requirePermission('vendor.manage'), VendorsController.recordPurchase);

// Payments & Recording
router.get('/:id/payments', authenticate, VendorsController.getPayments);
router.post('/:id/payments', authenticate, requirePermission('vendor.manage'), VendorsController.recordPayment);

// Ratings & Performance
router.patch('/:id/rating', authenticate, requirePermission('vendor.manage'), VendorsController.updateRating);

// Management CRUD
router.post('/', authenticate, requirePermission('vendor.manage'), VendorsController.create);
router.put('/:id', authenticate, requirePermission('vendor.manage'), VendorsController.update);
router.delete('/:id', authenticate, requirePermission('vendor.manage'), VendorsController.delete);

export default router;
