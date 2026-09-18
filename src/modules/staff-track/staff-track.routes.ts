import { Router } from 'express';
import { StaffTrackController } from './staff-track.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';

/**
 * Staff Track exposes one person's takings and activity to another, so every
 * route is gated on `stafftrack.view` at the server, not merely hidden in the
 * sidebar. `requirePermission` already lets ADMIN through, matching the rest of
 * the API; MANAGER inherits the permission from the role seed.
 */
const router = Router();

router.use(authenticate, requirePermission('stafftrack.view'));

router.get('/overview', StaffTrackController.getOverview);
router.get('/live', StaffTrackController.getLive);
router.get('/filters', StaffTrackController.getFilterOptions);

router.get('/staff', StaffTrackController.getStaff);
router.get('/staff/:id', StaffTrackController.getStaffDetail);

router.get('/orders', StaffTrackController.getOrders);
router.get('/orders/:orderId', StaffTrackController.getOrderDetail);

router.get('/revenue', StaffTrackController.getRevenue);
router.get('/tables', StaffTrackController.getTables);
router.get('/activity', StaffTrackController.getActivity);

router.get('/reports/orders', StaffTrackController.getOrdersReport);
router.get('/reports/revenue', StaffTrackController.getRevenueReport);
router.get('/reports/tables', StaffTrackController.getTablesReport);
router.get('/reports/activity', StaffTrackController.getActivityReport);
router.get('/reports/summary', StaffTrackController.getSummaryReport);

export default router;
