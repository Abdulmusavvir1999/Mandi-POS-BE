import { Router } from 'express';
import { ExpensesController } from '../controllers/expenses.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { createExpenseSchema, updateExpenseSchema } from '../validations/common.validation';

/**
 * Operating expenses. Reading is gated on `expense.view` and writing on
 * `expense.manage`, both seeded to ADMIN and MANAGER — spend records feed the
 * profit report, so a cashier can neither see nor create them.
 */
const router = Router();

router.get('/categories', authenticate, requirePermission('expense.view'), ExpensesController.getCategories);

router.get('/', authenticate, requirePermission('expense.view'), ExpensesController.getAll);
router.get('/:id', authenticate, requirePermission('expense.view'), ExpensesController.getById);

router.post(
  '/',
  authenticate,
  requirePermission('expense.manage'),
  validateBody(createExpenseSchema),
  ExpensesController.create
);
router.put(
  '/:id',
  authenticate,
  requirePermission('expense.manage'),
  validateBody(updateExpenseSchema),
  ExpensesController.update
);
router.delete('/:id', authenticate, requirePermission('expense.manage'), ExpensesController.delete);

export default router;
