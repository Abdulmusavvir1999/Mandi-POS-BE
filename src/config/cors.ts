import cors, { CorsOptions } from 'cors';
import { config } from './env';

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || config.corsOrigins.includes(origin) || config.nodeEnv === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // This is an allowlist, not a default — a header missing from it is refused
  // at the preflight and the real request is never sent, which the browser
  // reports only as a bare "CORS error".
  //
  // X-Back-Office-Unlock carries the Back-Office unlock grant. It is a custom
  // header, so every Back-Office request is preflighted and has to be named
  // here; Authorization alone is not enough.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Back-Office-Unlock'],
};

export const corsMiddleware = cors(corsOptions);
