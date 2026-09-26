import { createApp } from './app';
import { config } from './config/env';
import { logger } from './config/logger';
import { dbService } from './database/db';
import { CheckoutService } from './services/checkout.service';
import { StockService } from './services/stock.service';

const startServer = async () => {
  try {
    // 1. Connect to MySQL. Schema and seed data are managed out-of-band
    //    (see src/database/mysql_migrator.ts), not created on every boot.
    await dbService.initialize();
    await CheckoutService.ensureSchema();
    // Renames stock_entries -> stock_vendor_purchase on an older database before any
    // product, report or stock query can reach for the new name.
    await StockService.ensureSchema();

    // 2. Start Express App
    const app = createApp();
    const server = app.listen(config.port, () => {
      logger.info(`=======================================================`);
      logger.info(`  Shop POS & Management API Server Running `);
      logger.info(` Port: http://localhost:${config.port}`);
      logger.info(` Health check: http://localhost:${config.port}/api/health`);
      logger.info(` Environment: ${config.nodeEnv}`);
      logger.info(`=======================================================`);
    });

    // Graceful shutdown
    const shutdown = () => {
      logger.info('Shutting down API server gracefully...');
      server.close(async () => {
        await dbService.close();
        logger.info('HTTP server closed and database pool drained.');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
};

startServer();
