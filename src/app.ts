import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { corsMiddleware } from './config/cors';
import { requestLoggerMiddleware } from './middlewares/request-logger.middleware';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import apiRoutes from './routes';
import { UPLOAD_ROOT } from './services/branding.service';

export const createApp = (): express.Application => {
  const app = express();

  // Disable ETag caching to guarantee fresh 200 OK responses
  app.set('etag', false);
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

  // Security & standard middlewares
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(corsMiddleware);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Detailed console logger for every API call
  app.use(requestLoggerMiddleware);

  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('dev'));
  }

  // Branding images uploaded from the Store settings tab. Served ahead of the
  // API so the login page can fetch the hero image and favicon before anyone
  // has signed in; nosniff keeps a mislabelled file from being run as script.
  app.use(
    '/uploads',
    express.static(UPLOAD_ROOT, {
      index: false,
      setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
    })
  );

  // API routing
  app.use('/api', apiRoutes);

  // Global error & 404 handlers
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
