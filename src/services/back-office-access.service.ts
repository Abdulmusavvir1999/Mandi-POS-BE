import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { dbService } from '../database/db';
import { config } from '../config/env';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';

/**
 * The Back-Office unlock credential — `users.back_office_password`.
 *
 * This is the second lock in front of `/admin/back-office`. The first is the
 * role check: the super administrator reaches these endpoints and nobody else,
 * ADMIN included. This one exists because the login session alone should not
 * be enough — a terminal left signed in at the counter is a normal state of
 * affairs, and record deletion should not be one click away from it.
 *
 * The stored value is a bcrypt hash and is never selected into any response.
 * Nothing here touches `password_hash`: setting, changing or forgetting the
 * Back-Office password has no effect on signing in, and vice versa.
 */

/** How long one successful unlock lasts before the screen asks again. */
const UNLOCK_TTL_MINUTES = 30;

/** Marks a token as an unlock grant so a login JWT can never be passed off as one. */
const UNLOCK_PURPOSE = 'BACK_OFFICE_UNLOCK';

const MIN_PASSWORD_LENGTH = 6;

interface UnlockClaims {
  uid: number;
  purpose: string;
  /**
   * Fingerprint of the hash the unlock was granted against. Re-checked on
   * every request, so changing the Back-Office password immediately kills
   * every unlock still outstanding on other machines rather than leaving them
   * good for the rest of their half hour.
   */
  sig: string;
}

/** A short, non-reversible fingerprint of the stored hash. */
const fingerprint = (hash: string): string =>
  crypto.createHash('sha256').update(hash).digest('hex').slice(0, 32);

const readStoredHash = async (userId: number): Promise<string | null> => {
  const row = await dbService.queryOne<{ back_office_password: string | null }>(
    'SELECT back_office_password FROM users WHERE id = ?',
    [userId]
  );
  if (!row) {
    throw AppError.notFound('User not found');
  }
  const stored = row.back_office_password;
  return stored && stored.trim().length > 0 ? stored : null;
};

export class BackOfficeAccessService {
  /**
   * Whether this administrator has a Back-Office password yet.
   *
   * Reports only the boolean and the unlock lifetime — never the hash, and
   * never anything that would narrow down the password itself.
   */
  static async getStatus(userId: number) {
    const stored = await readStoredHash(userId);
    return {
      configured: stored !== null,
      unlockTtlMinutes: UNLOCK_TTL_MINUTES,
      minLength: MIN_PASSWORD_LENGTH,
    };
  }

  /**
   * Sets the Back-Office password, or replaces an existing one.
   *
   * The current password is deliberately not asked for. Holding an active
   * session as the super administrator is the whole gate — the role check has
   * already run, and there is no second proof on top of it. The consequence is
   * worth stating plainly: anyone at an unattended terminal still signed in as
   * the super administrator can re-key the Back-Office without knowing the
   * password it had.
   *
   * Every change still re-locks every session: the grants issued against the
   * old password stop being accepted the moment this returns.
   */
  static async setPassword(
    userId: number,
    input: { newPassword: string; confirmPassword: string }
  ) {
    const stored = await readStoredHash(userId);
    const isFirstTime = stored === null;

    const newPassword = (input.newPassword || '').trim();
    const confirmPassword = (input.confirmPassword || '').trim();

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw AppError.badRequest(
        `Back-Office password must be at least ${MIN_PASSWORD_LENGTH} characters`
      );
    }
    if (newPassword !== confirmPassword) {
      throw AppError.badRequest('Back-Office password and confirmation do not match');
    }

    if (!isFirstTime && (await bcrypt.compare(newPassword, stored as string))) {
      throw AppError.badRequest('The new Back-Office password must differ from the current one');
    }

    // Refuse to make it the login password. Keeping the two apart is the whole
    // point of the separate column, and letting them coincide silently would
    // undo that without the administrator ever being told.
    const loginRow = await dbService.queryOne<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = ?',
      [userId]
    );
    if (loginRow && (await bcrypt.compare(newPassword, loginRow.password_hash))) {
      throw AppError.badRequest('The Back-Office password must not be the same as your login password');
    }

    const hash = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(10));

    await dbService.execute(
      'UPDATE users SET back_office_password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [hash, userId]
    );

    await AuditService.log({
      userId,
      action: isFirstTime ? 'BACK_OFFICE_PASSWORD_SET' : 'BACK_OFFICE_PASSWORD_CHANGED',
      module: 'BACK_OFFICE',
      recordId: userId,
    });

    return {
      configured: true,
      message: isFirstTime
        ? 'Back-Office password set successfully'
        : 'Back-Office password changed successfully',
    };
  }

  /**
   * Checks the password typed on the unlock screen and, on a match, issues the
   * grant the Back-Office endpoints ask for.
   *
   * Every failure here is a 400. A wrong Back-Office password must not read as
   * an expired session, or the client's 401 handling would sign the
   * administrator out of the whole panel over a typo.
   */
  static async verify(
    userId: number,
    passwordPlain: string,
    context?: { ipAddress?: string; userAgent?: string }
  ) {
    const stored = await readStoredHash(userId);

    if (stored === null) {
      throw AppError.badRequest(
        'No Back-Office password has been set yet. Set one from Admin Profile, under Back-Office Password.'
      );
    }

    const matches = await bcrypt.compare(passwordPlain || '', stored);
    if (!matches) {
      await AuditService.log({
        userId,
        action: 'BACK_OFFICE_UNLOCK_FAILED',
        module: 'BACK_OFFICE',
        recordId: userId,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
      });
      throw AppError.badRequest('Incorrect Back-Office password');
    }

    const claims: UnlockClaims = { uid: userId, purpose: UNLOCK_PURPOSE, sig: fingerprint(stored) };
    const unlockToken = jwt.sign(claims, config.jwtSecret, { expiresIn: `${UNLOCK_TTL_MINUTES}m` });

    await AuditService.log({
      userId,
      action: 'BACK_OFFICE_UNLOCKED',
      module: 'BACK_OFFICE',
      recordId: userId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });

    return {
      unlockToken,
      expiresAt: new Date(Date.now() + UNLOCK_TTL_MINUTES * 60000).toISOString(),
      unlockTtlMinutes: UNLOCK_TTL_MINUTES,
    };
  }

  /**
   * Validates an unlock grant presented against a Back-Office endpoint.
   *
   * Three things have to hold: the token is a genuine unlock grant rather than
   * a login JWT, it belongs to the user making the request, and it was issued
   * against the password currently on the account.
   */
  static async assertUnlocked(userId: number, unlockToken?: string): Promise<void> {
    const locked = (message: string) => AppError.forbidden(message, 'BACK_OFFICE_LOCKED');

    if (!unlockToken) {
      throw locked('Back-Office is locked. Enter the Back-Office password to continue.');
    }

    let claims: UnlockClaims;
    try {
      claims = jwt.verify(unlockToken, config.jwtSecret) as unknown as UnlockClaims;
    } catch {
      throw locked('Back-Office session expired. Enter the Back-Office password again.');
    }

    if (claims.purpose !== UNLOCK_PURPOSE || Number(claims.uid) !== userId) {
      throw locked('Back-Office is locked. Enter the Back-Office password to continue.');
    }

    const stored = await readStoredHash(userId);
    if (stored === null || claims.sig !== fingerprint(stored)) {
      throw locked('The Back-Office password has changed. Enter the new one to continue.');
    }
  }
}
