import { Router } from 'express';
import { DiningTablesController } from './dining-tables.controller';
import { authenticate, requirePermission } from '../../core/middleware/auth.middleware';
import { validateBody } from '../../core/middleware/validate.middleware';
import { createDiningTableSchema } from '../../core/validation/common.validation';

const router = Router();

// Collections & Sections
router.get('/', authenticate, DiningTablesController.getAll);
router.get('/sections', authenticate, DiningTablesController.getSections);

// Reservations (must come before /:id)
router.get('/reservations', authenticate, DiningTablesController.getReservations);
router.post('/reservations', authenticate, requirePermission('dining.manage'), DiningTablesController.createReservation);
router.put('/reservations/:id/seat', authenticate, requirePermission('dining.manage'), DiningTablesController.seatReservation);
router.delete('/reservations/:id', authenticate, requirePermission('dining.manage'), DiningTablesController.cancelReservation);

// Waitlist & Queue Tokens (must come before /:id)
router.get('/waitlist', authenticate, DiningTablesController.getWaitlist);
router.post('/waitlist', authenticate, requirePermission('dining.manage'), DiningTablesController.addToWaitlist);
router.put('/waitlist/:id/seat', authenticate, requirePermission('dining.manage'), DiningTablesController.seatWaitlistParty);
router.patch('/waitlist/:id/status', authenticate, requirePermission('dining.manage'), DiningTablesController.updateWaitlistStatus);

// Table Specific Handlers
router.get('/:id', authenticate, DiningTablesController.getById);
router.get('/:id/history', authenticate, DiningTablesController.getTableHistory);
router.put('/:id/clean', authenticate, requirePermission('dining.manage'), DiningTablesController.cleanTable);
router.put('/:id/ready', authenticate, requirePermission('dining.manage'), DiningTablesController.finishCleaning);
router.put('/:id/seat', authenticate, requirePermission('dining.manage'), DiningTablesController.seatGuests);

// CRUD
router.post('/', authenticate, requirePermission('dining.manage'), validateBody(createDiningTableSchema), DiningTablesController.create);
router.put('/:id', authenticate, requirePermission('dining.manage'), DiningTablesController.update);
router.patch('/:id/status', authenticate, requirePermission('dining.manage'), DiningTablesController.setStatus);
router.delete('/:id', authenticate, requirePermission('dining.manage'), DiningTablesController.delete);

export default router;
