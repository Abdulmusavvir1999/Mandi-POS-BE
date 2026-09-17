import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';
import { logger } from '../../config/logger';
import { ResponseUtil } from '../utils/response.util';

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction): void => {
  if (err instanceof AppError) {
    logger.warn(`Operational Error [${err.code}] ${err.statusCode}: ${err.message} (${req.method} ${req.originalUrl})`);
    ResponseUtil.error(res, err.message, err.code, err.statusCode);
    return;
  }

  logger.error(`Unhandled Server Error: ${err.message}`, err.stack);
  ResponseUtil.error(res, 'Internal server error occurred. Please contact system administrator.', 'INTERNAL_SERVER_ERROR', 500);
};

export const notFoundHandler = (req: Request, res: Response): void => {
  ResponseUtil.error(res, `Resource not found: ${req.method} ${req.originalUrl}`, 'NOT_FOUND', 404);
};
