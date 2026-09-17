import { Router } from 'express';
import { RolesController } from './roles.controller';
import { authenticate, requireRole } from '../../core/middleware/auth.middleware';

const router = Router();

router.get('/roles', authenticate, RolesController.getRoles);
router.get('/permissions', authenticate, RolesController.getPermissions);
router.put('/roles/:id/permissions', authenticate, requireRole('ADMIN'), RolesController.updateRolePermissions);

export default router;
