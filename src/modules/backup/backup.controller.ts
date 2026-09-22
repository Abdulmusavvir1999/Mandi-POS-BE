import { Request, Response, NextFunction } from 'express';
import { BackupService } from './backup.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { AuditService } from '../audit/audit.service';
import { logger } from '../../config/logger';

export class BackupController {
  /** What a backup would contain, for the confirmation screen. */
  static async getInfo(req: Request, res: Response, next: NextFunction) {
    try {
      const info = await BackupService.getInfo();
      ResponseUtil.success(res, info, 'Backup information retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  /** The configured destination folder and whether it is currently usable. */
  static async getFolder(req: Request, res: Response, next: NextFunction) {
    try {
      const folder = await BackupService.getConfiguredFolder();

      if (!folder) {
        ResponseUtil.success(
          res,
          { path: '', configured: false, ok: false, exists: false, writable: false, message: '' },
          'No backup folder configured'
        );
        return;
      }

      const check = await BackupService.checkFolder(folder, false);
      ResponseUtil.success(res, { ...check, configured: true }, 'Backup folder retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates a folder without saving it, so the operator can test a path
   * before committing to it.
   */
  static async verifyFolder(req: Request, res: Response, next: NextFunction) {
    try {
      const check = await BackupService.checkFolder(
        String(req.body?.path ?? ''),
        req.body?.create === true
      );
      ResponseUtil.success(res, check, check.message);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Lists folders on the server for the Browse dialog. `?path=` omitted lists
   * the drive roots.
   */
  static async browse(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackupService.browse(req.query.path as string | undefined);
      ResponseUtil.success(res, result, 'Folders listed successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * Opens Windows' own Select Folder dialog on the POS server's desktop and
   * returns the chosen path.
   *
   * The request is deliberately held open while the dialog is up — someone
   * browsing their drives is not a stalled request — so the client should not
   * apply a short timeout to it.
   */
  static async pickFolder(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackupService.pickFolderNatively(
        typeof req.body?.initialPath === 'string' ? req.body.initialPath : undefined
      );

      switch (result.status) {
        case 'picked': {
          // Report writability straight away so the client does not have to
          // make a second call before it can enable Save.
          const check = await BackupService.checkFolder(result.path!, false);
          ResponseUtil.success(res, { status: 'picked', ...check }, 'Folder selected');
          return;
        }
        case 'cancelled':
          ResponseUtil.success(res, { status: 'cancelled' }, 'Selection cancelled');
          return;
        case 'unsupported':
          ResponseUtil.success(res, { status: 'unsupported', message: result.message }, result.message!);
          return;
        default:
          ResponseUtil.error(res, result.message!, 'FOLDER_DIALOG_FAILED', 400, { status: result.status });
          return;
      }
    } catch (err) {
      next(err);
    }
  }

  /** Whether the native dialog can be offered, so the UI can label Browse. */
  static async pickerAvailable(req: Request, res: Response, next: NextFunction) {
    try {
      const available = await BackupService.nativePickerAvailable();
      ResponseUtil.success(res, { available, platform: process.platform }, 'Picker availability checked');
    } catch (err) {
      next(err);
    }
  }

  /** Creates a subfolder from inside the Browse dialog. */
  static async createFolder(req: Request, res: Response, next: NextFunction) {
    try {
      const check = await BackupService.createSubfolder(
        String(req.body?.parent ?? ''),
        String(req.body?.name ?? '')
      );

      if (!check.ok) {
        ResponseUtil.error(res, check.message, 'FOLDER_NOT_CREATED', 400, check);
        return;
      }

      await AuditService.log({
        userId: req.user!.id,
        action: 'BACKUP_FOLDER_CREATED',
        module: 'BACKUP',
        newValues: { path: check.path },
      });

      ResponseUtil.created(res, check, 'Folder created successfully');
    } catch (err) {
      next(err);
    }
  }

  /** Validates and saves the destination folder. */
  static async setFolder(req: Request, res: Response, next: NextFunction) {
    try {
      const check = await BackupService.setConfiguredFolder(
        String(req.body?.path ?? ''),
        req.user!.id,
        req.body?.create === true
      );

      if (!check.ok) {
        ResponseUtil.error(res, check.message, 'INVALID_BACKUP_FOLDER', 400, check);
        return;
      }

      await AuditService.log({
        userId: req.user!.id,
        action: 'BACKUP_FOLDER_CONFIGURED',
        module: 'BACKUP',
        newValues: { path: check.path, created: check.created },
      });

      ResponseUtil.success(res, check, 'Backup folder saved successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * Runs a backup into the configured folder, server-side.
   *
   * This is the route the Backup Now button uses once a folder is set: the API
   * writes the file itself, so no download is involved and the operator does
   * not have to pick a location every time.
   */
  static async runToFolder(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackupService.runToConfiguredFolder();

      await AuditService.log({
        userId: req.user!.id,
        action: 'DATABASE_BACKUP_SAVED',
        module: 'BACKUP',
        newValues: { filePath: result.filePath, bytes: result.bytes },
        ipAddress: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });

      ResponseUtil.success(res, result, `Backup saved as ${result.fileName}`);
    } catch (err: any) {
      if (String(err?.message) === 'NO_BACKUP_FOLDER_CONFIGURED') {
        ResponseUtil.error(
          res,
          'No backup folder has been configured yet. Set one in Settings → Data Backup.',
          'NO_BACKUP_FOLDER_CONFIGURED',
          400
        );
        return;
      }
      logger.error('Backup to configured folder failed:', err);
      next(err);
    }
  }

  /**
   * Streams the whole database as a `.sql` download.
   *
   * The body starts flowing before the dump is finished, so an error after the
   * first byte cannot become a JSON error response — the status line is
   * already sent. `writeDump` writes a loud "INCOMPLETE, DO NOT RESTORE"
   * banner into the file in that case and the connection is then destroyed, so
   * the client sees a failed transfer rather than a silently truncated backup
   * that looks fine.
   */
  static async downloadDatabase(req: Request, res: Response, next: NextFunction) {
    const fileName = BackupService.suggestedFileName();

    try {
      res.setHeader('Content-Type', 'application/sql; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Cache-Control', 'no-store');
      // Length is unknown up front; without this some proxies buffer the whole
      // dump before forwarding a byte of it.
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Backup-Filename', fileName);

      await BackupService.writeDump(res);

      await AuditService.log({
        userId: req.user!.id,
        action: 'DATABASE_BACKUP_DOWNLOADED',
        module: 'BACKUP',
        newValues: { fileName },
        ipAddress: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });

      res.end();
    } catch (err) {
      logger.error('Database backup download failed:', err);

      if (res.headersSent) {
        // Destroying rather than ending marks the transfer as failed, so the
        // browser discards the partial file instead of saving it.
        res.destroy();
        return;
      }
      next(err);
    }
  }
}
