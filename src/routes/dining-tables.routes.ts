import { Router } from 'express';
import { DiningTablesController } from '../controllers/dining-tables.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { createDiningTableSchema } from '../validations/common.validation';

const router = Router();

// Collections & Sections
router.get('/', authenticate, DiningTablesController.getAll);
router.get('/sections', authenticate, DiningTablesController.getSections);

// Reservations (must come before /:id)
router.get('/reservations', authenticate, DiningTablesController.getReservations);
router.post('/reservations', authenticate, requirePermission('dining.manage'), DiningTablesController.createReservation);
router.put('/reservations/:id/seat', authenticate, requirePermission('dining.manage'), DiningTablesController.seatReservation);
router.delete('/reservations/:id', authenticate, requirePermission('dining.manage'), DiningTablesController.cancelReservation);

// Reservations page (params in the body)
router.post('/reservations/list', authenticate, DiningTablesController.listReservations);
router.post('/reservations/create', authenticate, requirePermission('dining.manage'), DiningTablesController.createReservation);
router.post('/reservations/seat', authenticate, requirePermission('dining.manage'), DiningTablesController.seatReservationPost);
router.post('/reservations/cancel', authenticate, requirePermission('dining.manage'), DiningTablesController.cancelReservationPost);
router.post('/reservations/no-show', authenticate, requirePermission('dining.manage'), DiningTablesController.noShowReservation);

// Open dining tabs: order in rounds, bill once (params in the body)
router.post('/tab/get', authenticate, DiningTablesController.getTab);
router.post('/tab/send', authenticate, requirePermission('pos.billing'), DiningTablesController.sendTabToKitchen);
router.post('/tab/remove-line', authenticate, requirePermission('pos.billing'), DiningTablesController.removeTabLine);
router.post('/tab/cancel', authenticate, requirePermission('pos.billing'), DiningTablesController.cancelTab);

// Table history page (filters + paging in the body)
router.post('/history', authenticate, DiningTablesController.getTableHistoryPage);

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
