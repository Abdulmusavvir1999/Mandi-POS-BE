import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes';
import usersRoutes from '../modules/users/users.routes';
import rolesRoutes from '../modules/roles/roles.routes';
import categoriesRoutes from '../modules/categories/categories.routes';
import productsRoutes from '../modules/products/products.routes';
import stockRoutes from '../modules/stock/stock.routes';
import customersRoutes from '../modules/customers/customers.routes';
import diningTablesRoutes from '../modules/dining-tables/dining-tables.routes';
import ordersRoutes from '../modules/orders/orders.routes';
import draftBillsRoutes from '../modules/draft-bills/draft-bills.routes';
import checkoutRoutes from '../modules/checkout/checkout.routes';
import billsRoutes from '../modules/bills/bills.routes';
import queueRoutes from '../modules/queue/queue.routes';
import dashboardRoutes from '../modules/dashboard/dashboard.routes';
import reportsRoutes from '../modules/reports/reports.routes';
import settingsRoutes from '../modules/settings/settings.routes';
import auditRoutes from '../modules/audit/audit.routes';

const router = Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    system: 'Mandi Shop POS & Management API',
    timestamp: new Date().toISOString(),
  });
});

router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/', rolesRoutes);
router.use('/categories', categoriesRoutes);
router.use('/products', productsRoutes);
router.use('/stock', stockRoutes);
router.use('/customers', customersRoutes);
router.use('/dining-tables', diningTablesRoutes);
router.use('/orders', ordersRoutes);
router.use('/draft-bills', draftBillsRoutes);
router.use('/checkout', checkoutRoutes);
router.use('/bills', billsRoutes);
router.use('/queue', queueRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/reports', reportsRoutes);
router.use('/settings', settingsRoutes);
router.use('/audit', auditRoutes);

export default router;
