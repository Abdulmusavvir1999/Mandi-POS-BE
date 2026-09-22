import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { BackOfficeAccessService } from './back-office-access.service';
import { ResponseUtil } from '../../core/utils/response.util';

/**
 * The three endpoints behind the Back-Office password.
 *
 * None of them ever echo the password or its hash back — the responses carry a
 * boolean, a message, or the unlock grant, and nothing else.
 */

export const setBackOfficePasswordSchema = z.object({
  newPassword: z.string().min(6, 'Back-Office password must be at least 6 characters'),
  confirmPassword: z.string().min(1, 'Please confirm the new Back-Office password'),
});

export const verifyBackOfficePasswordSchema = z.object({
  password: z.string().min(1, 'Back-Office password is required'),
});

export class BackOfficeAccessController {
  /** Has this administrator configured a Back-Office password yet? */
  static async status(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeAccessService.getStatus(req.user!.id);
      ResponseUtil.success(res, result, 'Back-Office access status retrieved');
    } catch (err) {
      next(err);
    }
  }

  /** Sets the Back-Office password for the first time, or replaces it. */
  static async setPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { newPassword, confirmPassword } = req.body;
      const result = await BackOfficeAccessService.setPassword(req.user!.id, {
        newPassword,
        confirmPassword,
      });
      ResponseUtil.success(res, { configured: result.configured }, result.message);
    } catch (err) {
      next(err);
    }
  }

  /** Checks the password typed on the unlock screen and issues the grant. */
  static async verify(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeAccessService.verify(req.user!.id, req.body.password, {
        ipAddress: req.ip || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
      });
      ResponseUtil.success(res, result, 'Back-Office unlocked');
    } catch (err) {
      next(err);
    }
  }
}
