import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'default_jwt_secret__pos_2026',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'default_jwt_refresh_secret__pos_2026',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:4200,http://localhost:3000').split(','),
  db: {
    host: process.env.LOC_DB_HOST || '192.168.10.15',
    // LOC_DB_PORT in .env was 8000 (the API port); MySQL/MariaDB listens on 3306.
    port: parseInt(process.env.LOC_DB_PORT || '3306', 10),
    user: process.env.LOC_DB_USER || 'shareuser',
    password: process.env.LOC_DB_PASS || '',
    database: process.env.LOC_DB_NAME || 'pos',
    poolMin: parseInt(process.env.LOC_DB_POOL_MIN || '2', 10),
    poolMax: parseInt(process.env.LOC_DB_POOL_MAX || '10', 10),
  },
};
