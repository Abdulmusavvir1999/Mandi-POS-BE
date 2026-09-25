import { Router } from 'express';
import { CustomersController } from '../controllers/customers.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { createCustomerSchema } from '../validations/common.validation';

const router = Router();

// Storewide CRM summary KPIs
router.get('/summary', authenticate, CustomersController.getSummary);

// Customers list and creation
router.get('/', authenticate, CustomersController.getAll);
router.post('/image', authenticate, requirePermission('customer.manage'), CustomersController.uploadImage);
router.post('/', authenticate, requirePermission('customer.manage'), validateBody(createCustomerSchema), CustomersController.create);

// Customer details, analytics, and history
router.get('/:id', authenticate, CustomersController.getById);
router.put('/:id', authenticate, requirePermission('customer.manage'), CustomersController.update);
router.delete('/:id', authenticate, requirePermission('customer.manage'), CustomersController.delete);

router.get('/:id/analytics', authenticate, CustomersController.getAnalytics);
router.get('/:id/purchase-history', authenticate, CustomersController.getPurchaseHistory);

// Customer Notes & Dietary Preferences
router.get('/:id/notes', authenticate, CustomersController.getNotes);
router.post('/:id/notes', authenticate, requirePermission('customer.manage'), CustomersController.createNote);
router.delete('/:id/notes/:noteId', authenticate, requirePermission('customer.manage'), CustomersController.deleteNote);

export default router;
