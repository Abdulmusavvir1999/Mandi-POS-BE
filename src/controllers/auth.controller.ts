import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { ResponseUtil } from '../utils/response.util';

export class AuthController {
  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { username, email, password } = req.body;
      const identifier = email || username;
      const ip = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];
      const result = await AuthService.login(identifier, password, ip, userAgent);
      ResponseUtil.success(res, result, 'Login successful');
    } catch (err) {
      next(err);
    }
  }

  static async refreshToken(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      const result = await AuthService.refreshToken(refreshToken);
      ResponseUtil.success(res, result, 'Token refreshed successfully');
    } catch (err) {
      next(err);
    }
  }

  static async me(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await AuthService.getMe(req.user!.id);
      ResponseUtil.success(res, result, 'Current user retrieved');
    } catch (err) {
      next(err);
    }
  }

  static async changePassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { currentPassword, newPassword } = req.body;
      const result = await AuthService.changePassword(req.user!.id, currentPassword, newPassword);
      ResponseUtil.success(res, result, 'Password changed successfully');
    } catch (err) {
      next(err);
    }
  }

  static async updateProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, email, phone, image_url } = req.body;
      const result = await AuthService.updateProfile(req.user!.id, { name, email, phone, image_url });
      ResponseUtil.success(res, result, 'Profile updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async logout(req: Request, res: Response, next: NextFunction) {
    try {
      ResponseUtil.success(res, { loggedOut: true }, 'Logged out successfully');
    } catch (err) {
      next(err);
    }
  }
}
