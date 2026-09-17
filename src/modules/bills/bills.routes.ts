import { Router } from 'express';
import { BillsController } from './bills.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

router.get('/', authenticate, requirePermission('bill.view'), BillsController.getAll);
router.get('/:id', authenticate, requirePermission('bill.view'), BillsController.getById);
router.get('/:id/print', authenticate, requirePermission('bill.print'), BillsController.getPrintData);

export default router;
