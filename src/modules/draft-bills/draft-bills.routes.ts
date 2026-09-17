import { Router } from 'express';
import { DraftBillsController } from './draft-bills.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

router.get('/', authenticate, DraftBillsController.getAll);
router.get('/:id', authenticate, DraftBillsController.getById);
router.post('/', authenticate, requirePermission('pos.hold_bill'), DraftBillsController.create);
router.post('/:id/resume', authenticate, requirePermission('pos.hold_bill'), DraftBillsController.resume);
router.delete('/:id', authenticate, requirePermission('pos.hold_bill'), DraftBillsController.delete);

export default router;
