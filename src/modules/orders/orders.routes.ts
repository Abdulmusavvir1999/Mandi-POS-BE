import { Router } from 'express';
import { OrdersController } from './orders.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

router.get('/', authenticate, OrdersController.getAll);
router.get('/:id', authenticate, OrdersController.getById);
router.post('/', authenticate, requirePermission('order.manage'), OrdersController.create);
router.post('/:id/start', authenticate, requirePermission('order.manage'), OrdersController.startOrder);
router.post('/:id/complete', authenticate, requirePermission('order.manage'), OrdersController.completeOrder);
router.post('/:id/cancel', authenticate, requirePermission('order.manage'), OrdersController.cancelOrder);

export default router;
