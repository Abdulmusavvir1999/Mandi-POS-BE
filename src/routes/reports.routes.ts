import { Router } from 'express';
import { ReportsController } from '../controllers/reports.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';

/**
 * Reporting & Business Intelligence.
 *
 * Every report is read-only and gated on `report.view`, which ADMIN passes
 * implicitly. The four original endpoints (`/sales`, `/products`,
 * `/categories`, `/stock`) are unchanged and still serve the existing reports
 * screen; the grouped routes below are the full suite.
 */
const router = Router();

const view = [authenticate, requirePermission('report.view')] as const;

// Catalog
router.get('/catalog', ...view, ReportsController.getCatalog);

// Original endpoints, kept for backward compatibility
router.get('/sales', ...view, ReportsController.getSalesReport);
router.get('/products', ...view, ReportsController.getProductSalesReport);
router.get('/categories', ...view, ReportsController.getCategorySalesReport);
router.get('/stock', ...view, ReportsController.getStockReport);

// Sales
router.get('/sales/products', ...view, ReportsController.salesByProduct);
router.get('/sales/categories', ...view, ReportsController.salesByCategory);
router.get('/sales/employees', ...view, ReportsController.salesByEmployee);
router.get('/sales/hourly', ...view, ReportsController.salesByHour);
router.get('/sales/order-types', ...view, ReportsController.salesByOrderType);
router.get('/sales/daily', ...view, ReportsController.dailySales);
router.get('/sales/monthly', ...view, ReportsController.monthlySales);
router.get('/sales/trends', ...view, ReportsController.salesTrends);

// Finance
router.get('/finance/revenue', ...view, ReportsController.revenue);
router.get('/finance/tax', ...view, ReportsController.tax);
router.get('/finance/discounts', ...view, ReportsController.discounts);
router.get('/finance/refunds', ...view, ReportsController.refunds);
router.get('/finance/payment-methods', ...view, ReportsController.paymentMethods);
router.get('/finance/expenses', ...view, ReportsController.expenses);
router.get('/finance/profit', ...view, ReportsController.profit);

// Inventory
router.get('/inventory/valuation', ...view, ReportsController.stockValuation);
router.get('/inventory/movement', ...view, ReportsController.stockMovement);
router.get('/inventory/wastage', ...view, ReportsController.wastage);
router.get('/inventory/purchases', ...view, ReportsController.purchases);
router.get('/inventory/consumption', ...view, ReportsController.consumption);
router.get('/inventory/food-cost', ...view, ReportsController.foodCost);
router.get('/inventory/variance', ...view, ReportsController.inventoryVariance);
router.get('/inventory/adjustments', ...view, ReportsController.stockAdjustments);

// Business Intelligence
router.get('/bi/product-performance', ...view, ReportsController.productPerformance);
router.get('/bi/customer-analytics', ...view, ReportsController.customerAnalytics);
router.get('/bi/sales-trends', ...view, ReportsController.biSalesTrends);
router.get('/bi/peak-hours', ...view, ReportsController.peakHours);
router.get('/bi/average-order-value', ...view, ReportsController.averageOrderValue);
router.get('/bi/repeat-customers', ...view, ReportsController.repeatCustomers);
router.get('/bi/dashboard-kpis', ...view, ReportsController.dashboardKpis);
router.get('/bi/employee-performance', ...view, ReportsController.employeePerformance);

export default router;
