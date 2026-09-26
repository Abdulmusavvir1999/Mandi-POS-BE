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

  // How long the browser may reuse a preflight result for a given URL.
  //
  // The app runs on a different origin from the API and every call carries an
  // Authorization header, so each one is preflighted. With no max-age Chrome
  // keeps a preflight for ~5 seconds, which means an OPTIONS round trip in
  // front of essentially every request — measured at half of all API round
  // trips on a page load. Ten minutes is the ceiling Chrome honours (Firefox
  // caps at 24h); the value only affects how soon a change to the CORS policy
  // itself is picked up, never authentication, which is re-checked on every
  // real request.
  maxAge: 600,
};

export const corsMiddleware = cors(corsOptions);
