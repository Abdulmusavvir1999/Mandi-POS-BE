import { Router } from 'express';
import { ReportsController } from './reports.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

const router = Router();

router.get('/sales', authenticate, requirePermission('report.view'), ReportsController.getSalesReport);
router.get('/products', authenticate, requirePermission('report.view'), ReportsController.getProductSalesReport);
router.get('/categories', authenticate, requirePermission('report.view'), ReportsController.getCategorySalesReport);
router.get('/stock', authenticate, requirePermission('report.view'), ReportsController.getStockReport);

export default router;
