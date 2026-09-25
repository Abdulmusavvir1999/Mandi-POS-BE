import { Router } from 'express';
import { BackupController } from '../controllers/backup.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

/**
 * Database backup — the server half of the Data Backup settings tab.
 *
 * Administrator-only, and more strictly so than most of Settings: the dump
 * contains every row of every table, including `users.password_hash`, every
 * customer's contact details and the whole audit trail. `requireRole('ADMIN')`
 * matches the rest of the Settings writes, and no lesser permission is offered
 * because there is no sensible half-access to a complete data export.
 *
 * Both routes are read-only against the database.
 */
const router = Router();

const adminOnly = [authenticate, requireRole('ADMIN')] as const;

router.get('/info', ...adminOnly, BackupController.getInfo);

// Destination folder — a path on the machine running this API.
router.get('/folder', ...adminOnly, BackupController.getFolder);

// Windows' own Select Folder dialog, opened on the server's desktop. This is
// what the Browse button uses on a standard single-PC install; the in-app
// browser below is the fallback when the native dialog is unavailable.
router.get('/folder/picker', ...adminOnly, BackupController.pickerAvailable);
router.post('/folder/pick', ...adminOnly, BackupController.pickFolder);

// In-app folder browser. Declared before `/folder` POST so neither shadows
// the other.
router.get('/folder/browse', ...adminOnly, BackupController.browse);
router.post('/folder/create', ...adminOnly, BackupController.createFolder);

router.post('/folder/verify', ...adminOnly, BackupController.verifyFolder);
router.post('/folder', ...adminOnly, BackupController.setFolder);

// Writes the backup server-side into the configured folder.
router.post('/run', ...adminOnly, BackupController.runToFolder);

// Streams the backup to the caller instead, for the download / folder-picker
// route used when no server folder is configured.
router.get('/database', ...adminOnly, BackupController.downloadDatabase);

export default router;
