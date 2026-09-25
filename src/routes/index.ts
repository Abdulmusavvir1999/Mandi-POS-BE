import { Router } from 'express';
import authRoutes from './auth.routes';
import usersRoutes from './users.routes';
import rolesRoutes from './roles.routes';
import categoriesRoutes from './categories.routes';
import productsRoutes from './products.routes';
import stockRoutes from './stock.routes';
import customersRoutes from './customers.routes';
import diningTablesRoutes from './dining-tables.routes';
import ordersRoutes from './orders.routes';
import draftBillsRoutes from './draft-bills.routes';
import checkoutRoutes from './checkout.routes';
import billsRoutes from './bills.routes';
import queueRoutes from './queue.routes';
import dashboardRoutes from './dashboard.routes';
import reportsRoutes from './reports.routes';
import settingsRoutes from './settings.routes';
import backupRoutes from './backup.routes';
import auditRoutes from './audit.routes';
import staffTrackRoutes from './staff-track.routes';
import vendorsRoutes from './vendors.routes';
import posClosingRoutes from './pos-closing.routes';
import expensesRoutes from './expenses.routes';
import refundsRoutes from './refunds.routes';
import backOfficeRoutes from './back-office.routes';

const router = Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    system: ' Shop POS & Management API',
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
router.use('/vendors', vendorsRoutes);
router.use('/dining-tables', diningTablesRoutes);
router.use('/orders', ordersRoutes);
router.use('/draft-bills', draftBillsRoutes);
router.use('/checkout', checkoutRoutes);
router.use('/bills', billsRoutes);
router.use('/pos/closing', posClosingRoutes);
router.use('/queue', queueRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/reports', reportsRoutes);
router.use('/expenses', expensesRoutes);
router.use('/refunds', refundsRoutes);
router.use('/settings', settingsRoutes);
router.use('/backup', backupRoutes);
router.use('/audit', auditRoutes);
router.use('/staff-track', staffTrackRoutes);

// Administrator-only Back-Office. Deliberately absent from the sidebar and
// every panel navigation — the screen is reached only via /admin/back-office.
router.use('/back-office', backOfficeRoutes);

export default router;
