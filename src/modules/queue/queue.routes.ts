import { Router } from 'express';
import { QueueController } from './queue.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

router.get('/', authenticate, QueueController.getAll);
router.get('/pending', authenticate, QueueController.getPending);
router.get('/:id', authenticate, QueueController.getById);
router.post('/', authenticate, requirePermission('queue.manage'), QueueController.create);
router.post('/:id/start', authenticate, requirePermission('queue.manage'), QueueController.start);
router.post('/:id/complete', authenticate, requirePermission('queue.manage'), QueueController.complete);
router.post('/:id/cancel', authenticate, requirePermission('queue.manage'), QueueController.cancel);

export default router;
