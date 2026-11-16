import type { ErrorRequestHandler, RequestHandler } from 'express';
import { MulterError } from 'multer';
import { z } from 'zod';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { AppError, NotFoundError } from './errors.js';

/** Prisma's known-request errors carry a `code` like `P2002` (unique violation). */
function prismaErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && /^P\d{4}$/.test(code)) return code;
  }
  return null;
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route matches ${req.method} ${req.originalUrl}`));
};

/**
 * Express 5 forwards rejected promises from async handlers here automatically,
 * so route handlers need no try/catch wrapper.
 */
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        ...(error.data !== undefined ? { data: error.data } : {}),
      },
    });
    return;
  }

  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'Request validation failed.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  // A rejected upload is the caller's mistake, not a bug: multer aborts the
  // stream itself, so without this the oversized-photo case would read as a 500.
  if (error instanceof MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'That photo is larger than 5 MB. Please choose a smaller one.'
        : `Upload rejected: ${error.message}.`;
    res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    return;
  }

  const prismaCode = prismaErrorCode(error);
  if (prismaCode === 'P2002') {
    res.status(409).json({
      error: { code: 'CONFLICT', message: 'That value is already taken.' },
    });
    return;
  }
  if (prismaCode === 'P2025') {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Resource not found.' },
    });
    return;
  }

  // Anything reaching here is a bug. Log it in full; tell the client nothing
  // beyond that it happened.
  logger.error({ err: error }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Something went wrong.',
      ...(env.isProduction ? {} : { debug: error instanceof Error ? error.message : String(error) }),
    },
  });
};
