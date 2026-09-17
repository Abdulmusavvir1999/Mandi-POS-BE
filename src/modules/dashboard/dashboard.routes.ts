import { Router } from 'express';
import { DashboardController } from './dashboard.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

router.get('/metrics', authenticate, requirePermission('dashboard.view'), DashboardController.getMetrics);

export default router;
