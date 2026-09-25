import { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';

// Helper to mask sensitive fields like passwords, tokens, pins
const sanitizePayload = (payload: any): any => {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map(sanitizePayload);
  }

  const sanitized: Record<string, any> = {};
  for (const [key, val] of Object.entries(payload)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('password') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('token') ||
      lowerKey.includes('pin') ||
      lowerKey.includes('authorization') ||
      lowerKey.includes('hash')
    ) {
      sanitized[key] = '********';
    } else if (typeof val === 'object' && val !== null) {
      sanitized[key] = sanitizePayload(val);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
};

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export const requestLoggerMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Request/response tracing is a development aid only.
  if (config.nodeEnv === 'production') {
    next();
    return;
  }

  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const method = req.method;
  const endpoint = req.originalUrl || req.url;

  const methodColor =
    method === 'GET' ? CYAN : method === 'POST' ? GREEN : method === 'PUT' || method === 'PATCH' ? YELLOW : method === 'DELETE' ? RED : MAGENTA;

  console.log(`\n${methodColor}[API REQUEST]${RESET}`);
  console.log(`  Method:    ${method}`);
  console.log(`  Endpoint:  ${endpoint}`);
  console.log(`  Timestamp: ${timestamp}`);

  if (Object.keys(req.query || {}).length > 0) {
    console.log(`  Query:     ${JSON.stringify(sanitizePayload(req.query))}`);
  }
  if (Object.keys(req.params || {}).length > 0) {
    console.log(`  Params:    ${JSON.stringify(sanitizePayload(req.params))}`);
  }
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(`  Body:      ${JSON.stringify(sanitizePayload(req.body))}`);
  }

  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const statusCode = res.statusCode;
    const isSuccess = statusCode >= 200 && statusCode < 400;
    const executionResult = isSuccess ? 'SUCCESS' : statusCode >= 500 ? 'SERVER ERROR' : 'FAILED';
    const statusColor = isSuccess ? GREEN : statusCode >= 500 ? RED : YELLOW;

    console.log(`${statusColor}[API RESPONSE]${RESET}`);
    console.log(`  Status:           ${statusCode}`);
    console.log(`  Execution Result: ${executionResult}`);
    console.log(`  ${DIM}${method} ${endpoint} (${durationMs}ms)${RESET}`);
  });

  next();
};
