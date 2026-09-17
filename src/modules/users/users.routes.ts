import { Router } from 'express';
import { UsersController } from './users.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';
import { validateBody } from '../../core/middleware/validate.middleware';
import { createUserSchema } from '../../core/validation/common.validation';

const router = Router();

router.get('/', authenticate, requirePermission('user.manage'), UsersController.getAll);
router.get('/:id', authenticate, requirePermission('user.manage'), UsersController.getById);
router.post('/', authenticate, requirePermission('user.manage'), validateBody(createUserSchema), UsersController.create);
router.put('/:id', authenticate, requirePermission('user.manage'), UsersController.update);
router.delete('/:id', authenticate, requirePermission('user.manage'), UsersController.delete);

export default router;
