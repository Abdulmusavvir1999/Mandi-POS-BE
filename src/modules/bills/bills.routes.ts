import { Router } from 'express';
import { BillsController } from './bills.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

router.get('/', authenticate, requirePermission('bill.view'), BillsController.getAll);
router.get('/:id', authenticate, requirePermission('bill.view'), BillsController.getById);
router.get('/:id/print', authenticate, requirePermission('bill.print'), BillsController.getPrintData);
router.get('/:id/kot', authenticate, requirePermission('bill.print'), BillsController.getKotPrintData);
router.get('/:id/duplicate', authenticate, requirePermission('pos.billing'), BillsController.getDuplicate);
router.post('/:id/void', authenticate, requirePermission('pos.billing'), BillsController.voidBill);
router.post('/:id/reopen', authenticate, requirePermission('pos.billing'), BillsController.reopenBill);

export default router;
