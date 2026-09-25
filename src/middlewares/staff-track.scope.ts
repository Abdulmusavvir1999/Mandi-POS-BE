import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';

/**
 * Staff Track visibility scope.
 *
 * The POS records no department, branch, shift or assignment for a user — the
 * `users` table is id/username/email/name/phone/role_id/status/last_login_at —
 * so there is no column to scope a viewer by beyond their own identity. The two
 * tiers below are therefore the only ones this schema can enforce honestly:
 *
 *   ALL   every staff member's figures (the whole-project view)
 *   SELF  only rows attributable to the viewer
 *
 * SELF is not a weaker version of ALL applied to the same rows; it re-points
 * each screen at the viewer's own attribution column (orders.created_by,
 * bills.cashier_id, audit_logs.user_id), which is exactly what `filters.userId`
 * already does on every endpoint that accepts it.
 */
export type StaffTrackScope = { kind: 'ALL' } | { kind: 'SELF'; userId: number };

declare global {
  namespace Express {
    interface Request {
      staffTrackScope?: StaffTrackScope;
    }
  }
}

/**
 * The permission test here is deliberately identical to `requirePermission`:
 * ADMIN passes implicitly, everyone else needs the granted code. Nothing about
 * the permission system changes — `stafftrack.view` still means "see every
 * staff member". The only change is what happens when the test fails: instead
 * of 403 on the whole module, the viewer drops to their own row.
 */
export const staffTrackScopeOf = (req: Request): StaffTrackScope => {
  if (!req.user) {
    throw AppError.unauthorized();
  }
  if (req.user.role === 'ADMIN' || req.user.permissions.includes('stafftrack.view')) {
    return { kind: 'ALL' };
  }
  return { kind: 'SELF', userId: req.user.id };
};

export const attachStaffTrackScope = (req: Request, _res: Response, next: NextFunction): void => {
  try {
    req.staffTrackScope = staffTrackScopeOf(req);
    next();
  } catch (err) {
    next(err);
  }
};

/** True when the viewer may read data belonging to `userId`. */
export const scopeAllowsUser = (scope: StaffTrackScope, userId: number): boolean =>
  scope.kind === 'ALL' || scope.userId === userId;

/**
 * Applied after the client's own filters are read, so a self-scoped caller
 * cannot widen the view by passing `?userId=` for somebody else — the forced
 * value overwrites whatever arrived on the query string.
 */
export const applyScopeToFilters = <T extends { userId?: number }>(filters: T, scope: StaffTrackScope): T =>
  scope.kind === 'ALL' ? filters : { ...filters, userId: scope.userId };

/** SQL fragment constraining `column` to the viewer, for the aggregate screens. */
export const scopeClause = (scope: StaffTrackScope, column: string): { sql: string; params: any[] } =>
  scope.kind === 'ALL' ? { sql: '', params: [] } : { sql: ` AND ${column} = ?`, params: [scope.userId] };
