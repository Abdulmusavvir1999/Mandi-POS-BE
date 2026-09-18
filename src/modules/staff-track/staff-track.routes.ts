import { Router } from 'express';
import { StaffTrackController } from './staff-track.controller';
import { authenticate } from '../../core/middleware/auth.middleware';
import { attachStaffTrackScope } from './staff-track.scope';

/**
 * Staff Track exposes one person's takings and activity to another, so the
 * whole-project view stays gated on `stafftrack.view` at the server, not merely
 * hidden in the sidebar. ADMIN passes implicitly and MANAGER inherits the grant
 * from the role seed, matching the rest of the API.
 *
 * Authentication alone now reaches these routes, but a caller without that
 * permission is scoped to their own attribution and can see nobody else: the
 * check moved from the router into `attachStaffTrackScope`, which every
 * controller below reads. Scoping is applied per query on the server, so a
 * self-scoped caller cannot widen the view with a crafted `?userId=`.
 */
const router = Router();

router.use(authenticate, attachStaffTrackScope);

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
