import { Router } from 'express';
import { DiningTablesController } from './dining-tables.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';
import { validateBody } from '../../core/middleware/validate.middleware';
import { createDiningTableSchema } from '../../core/validation/common.validation';

const router = Router();

router.get('/', authenticate, DiningTablesController.getAll);
router.get('/sections', authenticate, DiningTablesController.getSections);
router.get('/:id', authenticate, DiningTablesController.getById);
router.post('/', authenticate, requirePermission('dining.manage'), validateBody(createDiningTableSchema), DiningTablesController.create);
router.put('/:id', authenticate, requirePermission('dining.manage'), DiningTablesController.update);
router.patch('/:id/status', authenticate, requirePermission('dining.manage'), DiningTablesController.setStatus);
router.delete('/:id', authenticate, requirePermission('dining.manage'), DiningTablesController.delete);

export default router;
