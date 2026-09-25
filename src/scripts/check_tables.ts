import mysql from 'mysql2/promise';

async function checkPosDb() {
  const connection = await mysql.createConnection({
    host: '192.168.10.15',
    port: 3306,
    user: 'root',
    password: '',
    database: 'pos'
  });

  const [tables]: any = await connection.query('SHOW TABLES;');
  console.log('Tables in `pos` database:', tables);
  await connection.end();
}

checkPosDb().catch(err => console.error(err));
