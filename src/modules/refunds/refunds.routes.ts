import { Router } from 'express';
import { RefundsController } from './refunds.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';
import { validateBody } from '../../core/middleware/validate.middleware';
import { createRefundSchema } from '../../core/validation/common.validation';

/**
 * Refunds against settled bills. Reading needs `refund.view` (seeded to
 * ADMIN, MANAGER and CASHIER); issuing or cancelling needs `refund.manage`,
 * which cashiers do not get — returning money is a supervisor action.
 */
const router = Router();

router.get('/', authenticate, requirePermission('refund.view'), RefundsController.getAll);
router.get('/bill/:billId', authenticate, requirePermission('refund.view'), RefundsController.getByBill);
router.get('/:id', authenticate, requirePermission('refund.view'), RefundsController.getById);

router.post(
  '/',
  authenticate,
  requirePermission('refund.manage'),
  validateBody(createRefundSchema),
  RefundsController.create
);
router.patch('/:id/cancel', authenticate, requirePermission('refund.manage'), RefundsController.cancel);

export default router;
