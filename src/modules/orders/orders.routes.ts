import { Router } from 'express';
import { OrdersController } from './orders.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

// The order reads return staff attribution — `created_by_name` on the order and
// `changed_by_name` on each status transition — which is the same data Staff
// Track gates. They were reachable by any authenticated caller while every
// sibling module required a permission, so they now carry `order.manage` like
// the writes below. All four seeded roles hold it, and the Orders page is
// already guarded on it in the frontend, so no existing screen loses access.
router.get('/', authenticate, requirePermission('order.manage'), OrdersController.getAll);
router.get('/:id', authenticate, requirePermission('order.manage'), OrdersController.getById);
router.post('/', authenticate, requirePermission('order.manage'), OrdersController.create);
router.post('/:id/start', authenticate, requirePermission('order.manage'), OrdersController.startOrder);
router.post('/:id/complete', authenticate, requirePermission('order.manage'), OrdersController.completeOrder);
router.post('/:id/cancel', authenticate, requirePermission('order.manage'), OrdersController.cancelOrder);

export default router;
