import { Router } from 'express';
import { RolesController } from './roles.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

// Dynamic Roles endpoints
router.get('/roles', authenticate, RolesController.getRoles);
router.get('/roles/:id', authenticate, RolesController.getRoleById);
router.post('/roles', authenticate, requirePermission('user.manage'), RolesController.createRole);
router.put('/roles/:id', authenticate, requirePermission('user.manage'), RolesController.updateRole);
router.delete('/roles/:id', authenticate, requirePermission('user.manage'), RolesController.deleteRole);
router.put('/roles/:id/permissions', authenticate, requirePermission('user.manage'), RolesController.updateRolePermissions);

// Dynamic Permissions endpoints
router.get('/permissions', authenticate, RolesController.getPermissions);
router.post('/permissions', authenticate, requirePermission('user.manage'), RolesController.createPermission);
router.delete('/permissions/:id', authenticate, requirePermission('user.manage'), RolesController.deletePermission);

export default router;
