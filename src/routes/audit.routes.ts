import { Router } from 'express';
import { AuditController } from '../controllers/audit.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

const router = Router();

router.get('/', authenticate, requireRole('ADMIN'), AuditController.getLogs);

export default router;
