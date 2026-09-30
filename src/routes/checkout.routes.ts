import { Router } from 'express';
import { CheckoutController } from '../controllers/checkout.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.post('/sync-offline', authenticate, requirePermission('pos.billing'), CheckoutController.syncOffline);
// Live stock check for a cart or booking dishes: the checkout rule, nothing sold.
router.post('/stock-check', authenticate, CheckoutController.stockCheck);
router.post('/', authenticate, requirePermission('pos.billing'), CheckoutController.processCheckout);

export default router;
