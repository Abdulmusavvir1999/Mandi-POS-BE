import { Router } from 'express';
import { PosClosingController } from '../controllers/pos-closing.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.get('/current-shift', authenticate, requirePermission('pos.billing'), PosClosingController.getCurrentShift);
router.post('/', authenticate, requirePermission('pos.billing'), PosClosingController.createDayClosing);
router.get('/history', authenticate, requirePermission('pos.billing'), PosClosingController.getHistory);
router.get('/:id', authenticate, requirePermission('pos.billing'), PosClosingController.getById);

export default router;
