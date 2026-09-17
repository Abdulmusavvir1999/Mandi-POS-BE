import { Router } from 'express';
import { StockController } from './stock.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';
import { validateBody } from '../../core/middleware/validate.middleware';
import {
  stockInSchema,
  stockAdjustSchema,
  createStockItemSchema,
  updateStockItemSchema,
  createStockEntrySchema,
} from '../../core/validation/common.validation';

const router = Router();

// 1. Stock Master Items
router.get('/', authenticate, requirePermission('stock.view'), StockController.getCurrentStock);
router.get('/items/:id', authenticate, requirePermission('stock.view'), StockController.getStockItemById);
router.post('/items', authenticate, requirePermission('stock.manage'), validateBody(createStockItemSchema), StockController.createStockItem);
router.put('/items/:id', authenticate, requirePermission('stock.manage'), validateBody(updateStockItemSchema), StockController.updateStockItem);

// 2. Stock Purchase Entries
router.get('/entries', authenticate, requirePermission('stock.view'), StockController.getStockEntries);
router.post('/entries', authenticate, requirePermission('stock.manage'), validateBody(createStockEntrySchema), StockController.createStockEntry);

// 3. Stock Movements (Audit Trail)
router.get('/movements', authenticate, requirePermission('stock.view'), StockController.getStockMovements);

// 4. Stock Adjustments & Low Stock
router.post('/adjust', authenticate, requirePermission('stock.manage'), validateBody(stockAdjustSchema), StockController.adjustStock);
router.get('/low-stock', authenticate, requirePermission('stock.view'), StockController.getLowStock);

// 5. Backward-compatibility endpoints
router.post('/in', authenticate, requirePermission('stock.manage'), validateBody(stockInSchema), StockController.stockIn);
router.get('/transactions', authenticate, requirePermission('stock.view'), StockController.getTransactions);

export default router;
