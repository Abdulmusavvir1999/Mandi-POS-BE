import { Router } from 'express';
import { BackOfficeController } from './back-office.controller';
import {
  BackOfficeAccessController,
  setBackOfficePasswordSchema,
  verifyBackOfficePasswordSchema,
} from './back-office-access.controller';
import { requireBackOfficeUnlock } from './back-office-access.middleware';
import { authenticate, requireBackOfficeRole } from '../../core/middleware/auth.middleware';
import { validateBody } from '../../core/middleware/validate.middleware';

const router = Router();

/**
 * Back-Office API — the server half of `/admin/back-office`.
 *
 * Two locks, both enforced here rather than left to the browser.
 *
 * The first is the role: `requireBackOfficeRole` admits the super
 * administrator and nobody else — ADMIN is refused here as firmly as a cashier
 * is. These endpoints delete orders and invoices outright and re-price settled
 * bills, and no seeded permission code covers that; gating on an existing code
 * such as `order.manage` would silently hand record deletion to every cashier
 * and floor staff member.
 *
 * The second is the Back-Office password: `requireBackOfficeUnlock` wants the
 * grant issued by `POST /back-office/access/verify`, carried in the
 * `X-Back-Office-Unlock` header. Without it the password screen would be
 * decoration — an administrator's ordinary bearer token would still open every
 * endpoint below. The access routes themselves sit in front of that lock,
 * since they are how it gets opened.
 *
 * None of these routes are mounted over an existing module — the POS, Orders
 * and Bills endpoints are untouched and behave exactly as before.
 */
const adminOnly = [authenticate, requireBackOfficeRole];
const unlocked = [...adminOnly, requireBackOfficeUnlock];

// ── Access control ──────────────────────────────────────────────────────
// Reached from Admin Profile and from the unlock screen, so these stay
// outside `requireBackOfficeUnlock`.
router.get('/access/status', ...adminOnly, BackOfficeAccessController.status);
router.put(
  '/access/password',
  ...adminOnly,
  validateBody(setBackOfficePasswordSchema),
  BackOfficeAccessController.setPassword
);
router.post(
  '/access/verify',
  ...adminOnly,
  validateBody(verifyBackOfficePasswordSchema),
  BackOfficeAccessController.verify
);

// ── Orders ──────────────────────────────────────────────────────────────
router.get('/orders', ...unlocked, BackOfficeController.listOrders);
router.post('/orders', ...unlocked, BackOfficeController.createOrder);

// Declared before `/orders/:id` so the literal path is not swallowed by the
// id parameter.
router.get('/orders/deleted', ...unlocked, BackOfficeController.listDeletedOrders);
router.post('/orders/bulk-delete', ...unlocked, BackOfficeController.deleteOrders);
router.post('/orders/bulk-restore', ...unlocked, BackOfficeController.restoreOrders);
router.post('/orders/bulk-discount', ...unlocked, BackOfficeController.applyDiscount);

router.get('/orders/:id', ...unlocked, BackOfficeController.getOrder);
router.delete('/orders/:id', ...unlocked, BackOfficeController.deleteOrder);
router.post('/orders/:id/restore', ...unlocked, BackOfficeController.restoreOrder);

// ── Invoices ────────────────────────────────────────────────────────────
router.get('/invoices', ...unlocked, BackOfficeController.listInvoices);

// Literal paths before `/invoices/:id` so they are not swallowed by the id.
router.get('/invoices/deleted', ...unlocked, BackOfficeController.listDeletedInvoices);
router.post('/invoices/bulk-delete', ...unlocked, BackOfficeController.deleteInvoices);
router.post('/invoices/bulk-restore', ...unlocked, BackOfficeController.restoreInvoices);

router.get('/invoices/:id', ...unlocked, BackOfficeController.getInvoice);
router.delete('/invoices/:id', ...unlocked, BackOfficeController.deleteInvoice);
router.post('/invoices/:id/restore', ...unlocked, BackOfficeController.restoreInvoice);

export default router;
