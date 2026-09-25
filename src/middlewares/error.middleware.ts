import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';
import { logger } from '../config/logger';
import { config } from '../config/env';
import { ResponseUtil } from '../utils/response.util';

/**
 * Driver-level failures that describe a client mistake rather than a server
 * fault. Reporting them as 500 "contact system administrator" hid the actual
 * problem from both the user and whoever read the log, so each is mapped to the
 * status and wording that matches what really went wrong.
 */
const DB_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  ER_DUP_ENTRY: {
    status: 409,
    code: 'DUPLICATE_ENTRY',
    message: 'That record already exists. Please use a different value.',
  },
  ER_NO_REFERENCED_ROW: {
    status: 400,
    code: 'INVALID_REFERENCE',
    message: 'A linked record referenced by this request does not exist.',
  },
  ER_NO_REFERENCED_ROW_2: {
    status: 400,
    code: 'INVALID_REFERENCE',
    message: 'A linked record referenced by this request does not exist.',
  },
  ER_ROW_IS_REFERENCED: {
    status: 409,
    code: 'RECORD_IN_USE',
    message: 'This record is still in use elsewhere and cannot be removed.',
  },
  ER_ROW_IS_REFERENCED_2: {
    status: 409,
    code: 'RECORD_IN_USE',
    message: 'This record is still in use elsewhere and cannot be removed.',
  },
  ER_DATA_TOO_LONG: {
    status: 400,
    code: 'VALUE_TOO_LONG',
    message: 'One of the submitted values is too long for its field.',
  },
  ER_TRUNCATED_WRONG_VALUE: {
    status: 400,
    code: 'INVALID_VALUE',
    message: 'One of the submitted values is not in a format the database accepts.',
  },
  ER_WARN_DATA_OUT_OF_RANGE: {
    status: 400,
    code: 'VALUE_OUT_OF_RANGE',
    message: 'One of the submitted numeric values is out of the allowed range.',
  },
  ER_BAD_NULL_ERROR: {
    status: 400,
    code: 'MISSING_REQUIRED_FIELD',
    message: 'A required field was left empty.',
  },
};

/** Connection-level faults: the database is unreachable, not the caller's fault. */
const DB_UNAVAILABLE = new Set([
  'ECONNREFUSED',
  'PROTOCOL_CONNECTION_LOST',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ER_CON_COUNT_ERROR',
  'POOL_CLOSED',
]);

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction): void => {
  const context = `${req.method} ${req.originalUrl}`;

  // Express can reach here after a response has already started streaming (an
  // error thrown inside a serialiser, say). Writing a second time throws
  // ERR_HTTP_HEADERS_SENT and kills the socket, so hand it to Express to close.
  if (res.headersSent) {
    logger.error(`Error after response was sent [${context}]: ${err?.message}`);
    return;
  }

  if (err instanceof AppError) {
    logger.warn(`Operational Error [${err.code}] ${err.statusCode}: ${err.message} (${context})`);
    ResponseUtil.error(res, err.message, err.code, err.statusCode);
    return;
  }

  // Malformed JSON body — express.json() raises this before any handler runs.
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    logger.warn(`Malformed JSON body (${context})`);
    ResponseUtil.error(res, 'The request body is not valid JSON.', 'INVALID_JSON', 400);
    return;
  }

  if (err?.type === 'entity.too.large') {
    logger.warn(`Payload too large (${context})`);
    ResponseUtil.error(res, 'The uploaded content is too large.', 'PAYLOAD_TOO_LARGE', 413);
    return;
  }

  const dbCode: string | undefined = err?.code;

  if (dbCode && DB_UNAVAILABLE.has(dbCode)) {
    logger.error(`Database unavailable [${dbCode}] (${context}): ${err.message}`);
    ResponseUtil.error(
      res,
      'The service is temporarily unavailable. Please try again in a moment.',
      'SERVICE_UNAVAILABLE',
      503
    );
    return;
  }

  if (dbCode && DB_ERROR_MAP[dbCode]) {
    const mapped = DB_ERROR_MAP[dbCode];
    logger.warn(`Database constraint [${dbCode}] (${context}): ${err.message}`);
    ResponseUtil.error(res, mapped.message, mapped.code, mapped.status);
    return;
  }

  // Genuinely unexpected. Log everything available — the SQL included, since a
  // bad statement is the usual cause and the message alone never identified it.
  logger.error(`Unhandled Server Error (${context}): ${err?.message}`, err?.stack);
  if (err?.sql) {
    logger.error(`  Failing SQL [${dbCode ?? 'n/a'}]: ${String(err.sql).replace(/\s+/g, ' ').slice(0, 500)}`);
  }

  ResponseUtil.error(
    res,
    'Internal server error occurred. Please contact system administrator.',
    'INTERNAL_SERVER_ERROR',
    500,
    // The cause is echoed back outside production so the failing request can be
    // diagnosed from the browser instead of requiring server log access.
    config.nodeEnv === 'production' ? undefined : { reason: err?.message, code: dbCode }
  );
};

export const notFoundHandler = (req: Request, res: Response): void => {
  ResponseUtil.error(res, `Resource not found: ${req.method} ${req.originalUrl}`, 'NOT_FOUND', 404);
};
