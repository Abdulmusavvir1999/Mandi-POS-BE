/**
 * Resolving what role a user holds.
 *
 * Almost every account points at a row in `roles` through `users.role_id`, and
 * its role is that row's name. The super administrator is the exception: it
 * carries no `role_id` at all. There is deliberately no `roles` row for it, so
 * it cannot be handed out from the Roles screen, cannot be edited there, and
 * cannot be assigned to somebody by accident — the absence of a role is what
 * identifies it.
 */

/** The role name a user with no `role_id` resolves to. */
export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/**
 * What a user resolves to when `role_id` points at a row that is not there.
 *
 * A dangling id is not the same as no id, and must not be read as one — that
 * would turn a deleted role into a promotion to super administrator. It
 * resolves to a name that matches no check anywhere.
 */
export const UNRESOLVED_ROLE = 'UNASSIGNED';

/**
 * The role name for a user, given their `role_id` and the joined `roles.name`.
 *
 * Callers must LEFT JOIN `roles`, not JOIN — an inner join drops the super
 * administrator from the result set entirely and the account reads as if it
 * did not exist.
 */
export const resolveRoleName = (roleId: number | null | undefined, joinedRoleName?: string | null): string => {
  if (roleId === null || roleId === undefined) {
    return SUPER_ADMIN_ROLE;
  }
  return joinedRoleName || UNRESOLVED_ROLE;
};

/**
 * Compares role names with case and separators normalised away.
 *
 * `roles.name` is free text typed into the Roles screen, so an exact string
 * match would turn a stray underscore or a lowercase letter into a lockout.
 * `SUPER_ADMIN`, `superAdmin` and `Super Admin` all reduce to `SUPERADMIN`.
 */
export const normaliseRoleName = (role?: string | null): string =>
  String(role || '').toUpperCase().replace(/[^A-Z]/g, '');

/**
 * Whether this is the super administrator.
 *
 * The only account allowed into the Back-Office. ADMIN is deliberately not
 * included: the Back-Office deletes orders and invoices outright and re-prices
 * settled bills, and that is reserved for the super administrator alone.
 */
export const isSuperAdmin = (role?: string | null): boolean =>
  normaliseRoleName(role) === normaliseRoleName(SUPER_ADMIN_ROLE);

/**
 * Whether this account gets unrestricted access to the rest of the panel.
 *
 * ADMIN always has, through the `role === 'ADMIN'` short-circuits in
 * `requireRole` and `requirePermission`. The super administrator holds no
 * `role_id`, so it has no rows in `role_permissions` and would otherwise
 * resolve to an empty permission set — signed in, but bounced off every screen
 * it tried to open. It sits above ADMIN, so it is granted the same blanket
 * access rather than none.
 */
export const hasUnrestrictedAccess = (role?: string | null): boolean =>
  role === 'ADMIN' || isSuperAdmin(role);
