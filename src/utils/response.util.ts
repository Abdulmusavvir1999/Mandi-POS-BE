import { Response } from 'express';
import { ApiResponse, PaginatedResult } from '../models';

export class ResponseUtil {
  static success<T>(res: Response, data: T, message = 'Operation completed successfully', statusCode = 200): Response {
    const response: ApiResponse<T> = {
      success: true,
      message,
      data,
    };
    return res.status(statusCode).json(response);
  }

  static paginated<T>(
    res: Response,
    result: PaginatedResult<T>,
    message = 'Data fetched successfully',
    statusCode = 200
  ): Response {
    const response: ApiResponse<T[]> = {
      success: true,
      message,
      data: result.data,
      pagination: result.pagination,
    };
    return res.status(statusCode).json(response);
  }

  static created<T>(res: Response, data: T, message = 'Resource created successfully'): Response {
    return this.success(res, data, message, 201);
  }

  static noContent(res: Response): Response {
    return res.status(204).send();
  }

  static error(res: Response, message: string, code = 'ERROR', statusCode = 400, details?: any): Response {
    const response: ApiResponse = {
      success: false,
      message,
      error: {
        code,
        ...(details ? { details } : {}),
      },
    };
    return res.status(statusCode).json(response);
  }
}
