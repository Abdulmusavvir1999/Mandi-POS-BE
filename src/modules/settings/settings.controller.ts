import { Request, Response, NextFunction } from 'express';
import { SettingsService } from './settings.service';
import { BrandingService } from './branding.service';
import { ResponseUtil } from '../../core/utils/response.util';

export class SettingsController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await SettingsService.getAll();
      ResponseUtil.success(res, data, 'Settings fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getPublicSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await SettingsService.getPublicSettings();
      ResponseUtil.success(res, data, 'Public settings fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async updateBulk(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await SettingsService.updateBulk(req.body, req.user!.id);
      ResponseUtil.success(res, data, 'Settings updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async uploadBranding(req: Request, res: Response, next: NextFunction) {
    try {
      const { slot, dataUrl } = req.body || {};
      const data = BrandingService.save({ slot, dataUrl });
      ResponseUtil.success(res, data, 'Branding image uploaded successfully');
    } catch (err) {
      next(err);
    }
  }

  static async saveTabSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const { tab, settings } = req.body;
      const settingsPayload = settings !== undefined ? settings : req.body;
      const data = await SettingsService.saveTabSettings(tab, settingsPayload, req.user!.id);
      const message = tab ? `${String(tab).toUpperCase()} settings saved successfully` : 'Settings saved successfully';
      ResponseUtil.success(res, data, message);
    } catch (err) {
      next(err);
    }
  }
}
