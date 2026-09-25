import mysql from 'mysql2/promise';

async function testConnection() {
  const hosts = ['192.168.10.15', '127.0.0.1', 'localhost'];
  console.log('Testing MySQL connectivity to phpmyadmin server at 192.168.10.15...');

  for (const host of hosts) {
    try {
      console.log(`Attempting connection to ${host}:3306...`);
      const connection = await mysql.createConnection({
        host: host,
        port: 3306,
        user: 'root',
        password: '',
        connectTimeout: 4000
      });
      console.log(`✅ Successfully connected to MySQL at ${host}:3306!`);
      const [rows] = await connection.query('SHOW DATABASES;');
      console.log('Databases available:', rows);
      await connection.end();
      return;
    } catch (err: any) {
      console.log(`❌ Failed connecting to ${host}:3306:`, err.message);
    }
  }
}

testConnection();
