import { Router } from 'express';
import { SettingsController } from './settings.controller';
import { authenticate, requireRole } from '../../core/middleware/auth.middleware';

const router = Router();

router.get('/public', SettingsController.getPublicSettings);
router.get('/', authenticate, SettingsController.getAll);
router.put('/', authenticate, requireRole('ADMIN'), SettingsController.updateBulk);
router.post('/branding/upload', authenticate, requireRole('ADMIN'), SettingsController.uploadBranding);
router.post('/save', authenticate, requireRole('ADMIN'), SettingsController.saveTabSettings);
router.put('/save', authenticate, requireRole('ADMIN'), SettingsController.saveTabSettings);

export default router;
