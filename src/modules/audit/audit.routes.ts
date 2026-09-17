import { Router } from 'express';
import { AuditController } from './audit.controller';
import { authenticate, requireRole } from '../../core/middleware/auth.middleware';

const router = Router();

router.get('/', authenticate, requireRole('ADMIN'), AuditController.getLogs);

export default router;
