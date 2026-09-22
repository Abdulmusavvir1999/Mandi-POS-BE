import bcrypt from 'bcryptjs';
import readline from 'readline';
import { dbService } from '../database/db';

/**
 * Provisions the super administrator — the one account allowed into
 * `/admin/back-office`.
 *
 *   npx ts-node src/scripts/create-super-admin.ts
 *
 * It exists as a script rather than a screen because the account is defined by
 * having no `role_id`, and neither the Users screen nor the Roles screen can
 * produce that state — both require a role to be picked. Keeping it out here
 * also means the account cannot be created, re-roled or handed to somebody
 * from inside the running panel.
 *
 * Re-running is safe: an existing super administrator has its login password
 * reset rather than being duplicated. The Back-Office password is left alone —
 * it is set from Admin Profile, and this script has no business overwriting it.
 *
 * Run back_office_password_migration.sql first; `users.role_id` has to be
 * nullable before a row like this can be written.
 */

const USERNAME = process.env.SUPER_ADMIN_USERNAME || 'superadmin';
const EMAIL = process.env.SUPER_ADMIN_EMAIL || 'superadmin@mandipos.com';
const NAME = process.env.SUPER_ADMIN_NAME || 'Super Administrator';

const ask = (question: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
};

const run = async (): Promise<void> => {
  await dbService.initialize();

  // The column has to be nullable or the INSERT below is rejected, with an
  // error that does not say why. Check it first and say so plainly.
  const column = await dbService.queryOne<{ IS_NULLABLE: string }>(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role_id'`
  );
  if (column && column.IS_NULLABLE !== 'YES') {
    console.error(
      '\n  users.role_id is still NOT NULL, so a super administrator cannot be created.\n' +
      '  Run back_office_password_migration.sql against this database first.\n'
    );
    process.exit(1);
  }

  const password = (process.env.SUPER_ADMIN_PASSWORD || (await ask('Login password for the super administrator: '))).trim();
  if (password.length < 6) {
    console.error('\n  Password must be at least 6 characters.\n');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));

  const existing = await dbService.queryOne<{ id: number; role_id: number | null }>(
    'SELECT id, role_id FROM users WHERE username = ? OR email = ?',
    [USERNAME, EMAIL]
  );

  if (existing) {
    // Refuse to strip the role off an ordinary account that happens to share
    // the name. Promoting a real user to super administrator by side effect is
    // exactly the accident this account is meant to be safe from.
    if (existing.role_id !== null) {
      console.error(
        `\n  A user named "${USERNAME}" already exists and holds a role (role_id = ${existing.role_id}).\n` +
        '  Refusing to strip its role. Rename that account, or set SUPER_ADMIN_USERNAME\n' +
        '  and SUPER_ADMIN_EMAIL to something else and re-run.\n'
      );
      process.exit(1);
    }

    await dbService.execute(
      'UPDATE users SET password_hash = ?, name = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [hash, NAME, 'ACTIVE', existing.id]
    );
    console.log(`\n  Super administrator "${USERNAME}" updated (login password reset).`);
  } else {
    await dbService.execute(
      'INSERT INTO users (username, email, password_hash, name, role_id, status) VALUES (?, ?, ?, ?, NULL, ?)',
      [USERNAME, EMAIL, hash, NAME, 'ACTIVE']
    );
    console.log(`\n  Super administrator "${USERNAME}" created.`);
  }

  console.log(`  Sign in as ${USERNAME} / ${EMAIL}, then set the Back-Office password`);
  console.log('  from My Profile, under Back-Office Password, before opening /admin/back-office.\n');

  await dbService.close();
};

run().catch(async (err) => {
  console.error('\n  Failed to create the super administrator:', err?.message || err, '\n');
  process.exit(1);
});
