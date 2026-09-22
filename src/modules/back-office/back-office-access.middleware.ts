import { Request, Response, NextFunction } from 'express';
import { BackOfficeAccessService } from './back-office-access.service';

/** Header the client carries its unlock grant in. */
export const UNLOCK_HEADER = 'x-back-office-unlock';

/**
 * Requires a valid Back-Office unlock on top of authentication and the role
 * check.
 *
 * Without this the password screen would be decoration: the role alone still
 * opens every Back-Office endpoint, and an administrator's own bearer token is
 * all anyone would need to delete records straight from a terminal. Mounted on
 * the data routes only — the access endpoints themselves (status, set
 * password, verify) sit in front of the lock by necessity.
 */
export const requireBackOfficeUnlock = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const header = req.headers[UNLOCK_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    await BackOfficeAccessService.assertUnlocked(req.user!.id, token);
    next();
  } catch (err) {
    next(err);
  }
};
