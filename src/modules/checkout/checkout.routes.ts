import { Router } from 'express';
import { CheckoutController } from './checkout.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

router.post('/sync-offline', authenticate, requirePermission('pos.billing'), CheckoutController.syncOffline);
router.post('/', authenticate, requirePermission('pos.billing'), CheckoutController.processCheckout);

export default router;
