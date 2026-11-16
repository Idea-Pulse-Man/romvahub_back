import path from 'node:path';
import express, { type Express, type RequestHandler, Router } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import * as helmetModule from 'helmet';
import type { HelmetOptions } from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';

import { env } from './env.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { errorHandler, notFoundHandler } from './http/error-handler.js';
import { adminUsersRouter } from './admin/users.routes.js';
import { adminProfilesRouter } from './admin/profiles.routes.js';
import { aiConfigRouter } from './ai-config/ai-config.routes.js';
import { authRouter } from './auth/auth.routes.js';
import { bidsRouter } from './bids/bids.routes.js';
import { coverLetterRouter } from './cover-letter/cover-letter.routes.js';
import { jobsRouter } from './jobs/jobs.routes.js';
import { profileRouter } from './profile/profile.routes.js';
import { sharedProfilesRouter } from './profiles/shared-profiles.routes.js';
import { questionsRouter } from './questions/questions.routes.js';
import { resumeRouter } from './resume/resume.routes.js';
import { settingsRouter } from './settings/settings.routes.js';
import { dashboardRouter } from './dashboard/dashboard.routes.js';
import { notificationsRouter } from './notifications/notifications.routes.js';
import { dataRouter } from './data/data.routes.js';
import { localRouter } from './local/local.routes.js';
import { openApiDocument } from './docs/openapi.js';

// helmet's `exports` map carries no "types" condition, so a toolchain that
// reads its CommonJS declarations from this ESM file — Vercel's function
// compiler does — types the import as the module object rather than as the
// middleware factory, and a plain `helmet(...)` call stops compiling there.
// `.default` is the factory in both of helmet's builds and in both of its
// declaration files; the cast is what the CommonJS view of them needs.
const helmet = helmetModule.default as unknown as (options?: HelmetOptions) => RequestHandler;

export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy in production, so that Secure cookies and the rate
  // limiter see the real client protocol and IP rather than the proxy's.
  if (env.isProduction) app.set('trust proxy', 1);

  app.disable('x-powered-by');

  app.use(
    helmet({
      // The Swagger UI page needs inline styles; the API itself serves only
      // JSON, where CSP does no work.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: env.corsOrigins,
      // Required for the httpOnly auth cookies to be sent cross-origin, which
      // the Vite dev server on :5173 always is.
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '10mb' })); // large enough for a full data import
  app.use(cookieParser());

  if (env.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger }));
  }

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });

  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'RemoteOps API',
      swaggerOptions: { persistAuthorization: true, withCredentials: true },
    }),
  );

  const api = Router();
  api.use('/auth', authRouter);
  api.use('/bids', bidsRouter);
  api.use('/jobs', jobsRouter);
  api.use('/profile', profileRouter);
  api.use('/profiles', sharedProfilesRouter);
  api.use('/resume', resumeRouter);
  api.use('/cover-letter', coverLetterRouter);
  api.use('/questions', questionsRouter);
  api.use('/settings', settingsRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/data', dataRouter);
  api.use('/local', localRouter);
  api.use('/admin/ai', aiConfigRouter);
  api.use('/admin/users', adminUsersRouter);
  api.use('/admin/profiles', adminProfilesRouter);
  app.use('/api', api);

  // The desktop app: this server also serves the built website, so the window
  // has one origin for pages and API alike (and the cookies behave as on the
  // web). Any path that is not the API, the docs or the health check is the
  // single-page app; its router takes it from there.
  if (env.FRONTEND_DIR) {
    const frontendDir = path.resolve(env.FRONTEND_DIR);
    app.use(express.static(frontendDir, { index: false }));
    app.get(/^\/(?!api\/|api$|docs|health$|openapi\.json$).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(frontendDir, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
