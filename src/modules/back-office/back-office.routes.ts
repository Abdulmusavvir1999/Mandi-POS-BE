import { Router } from 'express';
import { BackOfficeController } from './back-office.controller';
import { authenticate, requireRole } from '../../core/middleware/auth.middleware';

const router = Router();

/**
 * Back-Office API — the server half of `/admin/back-office`.
 *
 * Everything here is administrator-only. `requireRole()` with no role list
 * admits ADMIN and nobody else, which is deliberate: these endpoints delete
 * orders and invoices outright and re-price settled bills, and no seeded
 * permission code covers that. Gating on an existing code such as
 * `order.manage` would silently hand record deletion to every cashier and
 * floor staff member, so the role check is used instead of inventing a new
 * permission that existing databases would not have.
 *
 * None of these routes are mounted over an existing module — the POS, Orders
 * and Bills endpoints are untouched and behave exactly as before.
 */
const adminOnly = [authenticate, requireRole()];

// ── Orders ──────────────────────────────────────────────────────────────
router.get('/orders', ...adminOnly, BackOfficeController.listOrders);
router.post('/orders', ...adminOnly, BackOfficeController.createOrder);

// Declared before `/orders/:id` so the literal path is not swallowed by the
// id parameter.
router.post('/orders/bulk-delete', ...adminOnly, BackOfficeController.deleteOrders);
router.post('/orders/bulk-discount', ...adminOnly, BackOfficeController.applyDiscount);

router.get('/orders/:id', ...adminOnly, BackOfficeController.getOrder);
router.delete('/orders/:id', ...adminOnly, BackOfficeController.deleteOrder);

// ── Invoices ────────────────────────────────────────────────────────────
router.get('/invoices', ...adminOnly, BackOfficeController.listInvoices);
router.post('/invoices/bulk-delete', ...adminOnly, BackOfficeController.deleteInvoices);
router.get('/invoices/:id', ...adminOnly, BackOfficeController.getInvoice);
router.delete('/invoices/:id', ...adminOnly, BackOfficeController.deleteInvoice);

export default router;
