import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { dbService } from '../database/db';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DB_HOST = process.env.DB_HOST || '192.168.10.15';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'pos';

async function updateDbCredentials() {
  console.log('--- 1. Updating SQLite Database ---');
  await dbService.initialize();

  const salt = bcrypt.genSaltSync(10);
  const usersToUpdate = [
    { username: 'admin', email: 'admin@projectx.com', pass: 'Super@123', name: 'System Administrator', role_id: 1, phone: '+91 98765 43210' },
    { username: 'manager', email: 'manager@projectx.com', pass: 'Super@123', name: 'Operations Manager', role_id: 2, phone: '+91 98765 43211' },
    { username: 'cashier', email: 'cashier@projectx.com', pass: 'Super@123', name: 'Head Cashier', role_id: 3, phone: '+91 98765 43212' },
    { username: 'staff', email: 'staff@projectx.com', pass: 'Super@123', name: 'Service Staff', role_id: 4, phone: '+91 98765 43213' }
  ];

  for (const u of usersToUpdate) {
    const hash = bcrypt.hashSync(u.pass, salt);
    const existing: any = await dbService.queryOne('SELECT id FROM users WHERE username = ? OR email = ?', [u.username, u.email]);
    if (existing) {
      await dbService.execute('UPDATE users SET password_hash = ?, email = ?, name = ?, phone = ?, role_id = ?, status = ? WHERE id = ?', [
        hash,
        u.email,
        u.name,
        u.phone,
        u.role_id,
        'ACTIVE',
        existing.id
      ]);
      console.log(`MySQL: Updated user ${u.username} (${u.email}) with password ${u.pass}`);
    } else {
      await dbService.execute('INSERT INTO users (username, email, password_hash, name, phone, role_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        u.username,
        u.email,
        hash,
        u.name,
        u.phone,
        u.role_id,
        'ACTIVE'
      ]);
      console.log(`MySQL: Created user ${u.username} (${u.email}) with password ${u.pass}`);
    }
  }

  const currentSqliteUsers = await dbService.query('SELECT id, username, email, name, role_id, status FROM users');
  console.log('\nCurrent Users:');
  console.table(currentSqliteUsers);

  console.log('\n--- 2. Updating MySQL Database at ' + DB_HOST + ' (' + DB_NAME + ') ---');
  try {
    const conn = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME
    });

    for (const u of usersToUpdate) {
      const hash = bcrypt.hashSync(u.pass, salt);
      const [existingRows]: any = await conn.query('SELECT id FROM users WHERE username = ? OR email = ?', [u.username, u.email]);
      if (existingRows.length > 0) {
        await conn.query('UPDATE users SET password_hash = ?, email = ?, name = ?, phone = ?, role_id = ?, status = ? WHERE id = ?', [
          hash,
          u.email,
          u.name,
          u.phone,
          u.role_id,
          'ACTIVE',
          existingRows[0].id
        ]);
        console.log(`MySQL: Updated user ${u.username} (${u.email}) with password ${u.pass}`);
      } else {
        await conn.query('INSERT INTO users (username, email, password_hash, name, phone, role_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          u.username,
          u.email,
          hash,
          u.name,
          u.phone,
          u.role_id,
          'ACTIVE'
        ]);
        console.log(`MySQL: Created user ${u.username} (${u.email}) with password ${u.pass}`);
      }
    }

    const [mysqlUsers]: any = await conn.query('SELECT id, username, email, name, role_id, status FROM users');
    console.log('\nCurrent MySQL Users:');
    console.table(mysqlUsers);
    await conn.end();
  } catch (err: any) {
    console.error('MySQL update error:', err.message);
  }

  console.log('\n✅ Database login credentials synchronization complete!');
}

updateDbCredentials().catch(err => console.error('Execution error:', err));
