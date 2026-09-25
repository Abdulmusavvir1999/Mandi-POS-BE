import { Router } from 'express';
import { RolesController } from '../controllers/roles.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

// Every endpoint is POST — the action is in the path, the ids and payload are
// in the body. No :id path params, no query strings.

// Dynamic Roles endpoints
router.post('/roles/list', authenticate, RolesController.getRoles);
router.post('/roles/get', authenticate, RolesController.getRoleById);
router.post('/roles/create', authenticate, requirePermission('user.manage'), RolesController.createRole);
router.post('/roles/update', authenticate, requirePermission('user.manage'), RolesController.updateRole);
router.post('/roles/delete', authenticate, requirePermission('user.manage'), RolesController.deleteRole);
router.post('/roles/permissions/update', authenticate, requirePermission('user.manage'), RolesController.updateRolePermissions);

// Dynamic Permissions endpoints
router.post('/permissions/list', authenticate, RolesController.getPermissions);
router.post('/permissions/create', authenticate, requirePermission('user.manage'), RolesController.createPermission);
router.post('/permissions/delete', authenticate, requirePermission('user.manage'), RolesController.deletePermission);

export default router;
