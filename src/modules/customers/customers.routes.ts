import { Router } from 'express';
import { CustomersController } from './customers.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';
import { validateBody } from '../../core/middleware/validate.middleware';
import { createCustomerSchema } from '../../core/validation/common.validation';

const router = Router();

router.get('/', authenticate, CustomersController.getAll);
router.get('/:id', authenticate, CustomersController.getById);
router.get('/:id/purchase-history', authenticate, CustomersController.getPurchaseHistory);
router.post('/image', authenticate, requirePermission('customer.manage'), CustomersController.uploadImage);
router.post('/', authenticate, requirePermission('customer.manage'), validateBody(createCustomerSchema), CustomersController.create);
router.put('/:id', authenticate, requirePermission('customer.manage'), CustomersController.update);
router.delete('/:id', authenticate, requirePermission('customer.manage'), CustomersController.delete);

export default router;
