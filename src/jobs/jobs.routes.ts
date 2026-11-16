import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../env.js';
import { requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { ParseJobSchema, type ParseJobInput } from './jobs.schemas.js';
import * as jobsService from './jobs.service.js';

export const jobsRouter: Router = Router();

jobsRouter.use(requireAuth);

/**
 * The only route that makes the server issue outbound requests, so it is the
 * only one where a bored client costs someone else bandwidth. The limit is well
 * above what filling in a form needs and well below what a scraper wants.
 */
const parseLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many job URLs parsed. Please wait a minute and try again.',
    },
  },
});

jobsRouter.post('/parse', parseLimiter, validate({ body: ParseJobSchema }), async (req, res) => {
  const { url } = (req as ValidatedRequest<ParseJobInput>).valid.body;
  res.json(await jobsService.parseJobUrl(url));
});
