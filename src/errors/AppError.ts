export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 400, code = 'BAD_REQUEST', isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(msg: string, code = 'BAD_REQUEST') {
    return new AppError(msg, 400, code);
  }

  static unauthorized(msg = 'Unauthorized access', code = 'UNAUTHORIZED') {
    return new AppError(msg, 401, code);
  }

  static forbidden(msg = 'Forbidden: insufficient permissions', code = 'FORBIDDEN') {
    return new AppError(msg, 403, code);
  }

  static notFound(msg = 'Resource not found', code = 'NOT_FOUND') {
    return new AppError(msg, 404, code);
  }

  static conflict(msg: string, code = 'CONFLICT') {
    return new AppError(msg, 409, code);
  }

  static unprocessable(msg: string, code = 'UNPROCESSABLE_ENTITY') {
    return new AppError(msg, 422, code);
  }

  static internal(msg = 'Internal server error', code = 'INTERNAL_ERROR') {
    return new AppError(msg, 500, code, false);
  }
}
