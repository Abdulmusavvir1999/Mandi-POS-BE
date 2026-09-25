import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { validateBody } from '../middlewares/validate.middleware';
import { loginSchema, changePasswordSchema, refreshTokenSchema, updateProfileSchema } from '../validations/auth.validation';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

router.post('/login', validateBody(loginSchema), AuthController.login);
router.post('/refresh', validateBody(refreshTokenSchema), AuthController.refreshToken);
router.post('/logout', authenticate, AuthController.logout);
router.post('/logout-all', authenticate, AuthController.logout);
router.post('/change-password', authenticate, validateBody(changePasswordSchema), AuthController.changePassword);
router.get('/me', authenticate, AuthController.me);
router.put('/me', authenticate, validateBody(updateProfileSchema), AuthController.updateProfile);
router.put('/profile', authenticate, validateBody(updateProfileSchema), AuthController.updateProfile);

export default router;
