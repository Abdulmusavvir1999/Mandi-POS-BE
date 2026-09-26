import { Router } from 'express';
import { VendorsController } from '../controllers/vendors.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

// Stats summary
router.get('/stats', authenticate, VendorsController.getStats);

// Listing and details
router.get('/', authenticate, VendorsController.getAll);
router.get('/:id', authenticate, VendorsController.getById);

// Purchase History & Recording
router.get('/:id/purchases', authenticate, VendorsController.getPurchases);
router.post('/:id/purchases', authenticate, requirePermission('vendor.manage'), VendorsController.recordPurchase);
router.put('/:id/purchases/:purchaseId', authenticate, requirePermission('vendor.manage'), VendorsController.updatePurchase);
router.delete('/:id/purchases/:purchaseId', authenticate, requirePermission('vendor.manage'), VendorsController.deletePurchase);

// Payments & Recording
router.get('/:id/payments', authenticate, VendorsController.getPayments);
router.post('/:id/payments', authenticate, requirePermission('vendor.manage'), VendorsController.recordPayment);
router.put('/:id/payments/:paymentId', authenticate, requirePermission('vendor.manage'), VendorsController.updatePayment);
router.delete('/:id/payments/:paymentId', authenticate, requirePermission('vendor.manage'), VendorsController.deletePayment);

// Audit Logs
router.get('/:id/audit-logs', authenticate, VendorsController.getAuditLogs);


// Management CRUD
router.post('/image', authenticate, requirePermission('vendor.manage'), VendorsController.uploadImage);
router.post('/', authenticate, requirePermission('vendor.manage'), VendorsController.create);
router.put('/:id', authenticate, requirePermission('vendor.manage'), VendorsController.update);
router.delete('/:id', authenticate, requirePermission('vendor.manage'), VendorsController.delete);

export default router;
