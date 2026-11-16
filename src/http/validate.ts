import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodType } from 'zod';
import { BadRequestError, type ErrorDetail } from './errors.js';

/**
 * Parses `req.body` / `req.params` / `req.query` against Zod schemas and
 * replaces them with the parsed (coerced, stripped) values, so handlers work
 * with typed data rather than `unknown`.
 */
export interface ValidationSchemas<TBody, TParams, TQuery> {
  body?: ZodType<TBody>;
  params?: ZodType<TParams>;
  query?: ZodType<TQuery>;
}

export interface ValidatedRequest<TBody = unknown, TParams = unknown, TQuery = unknown>
  extends Request {
  valid: {
    body: TBody;
    params: TParams;
    query: TQuery;
  };
}

function toDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function validate<TBody = unknown, TParams = unknown, TQuery = unknown>(
  schemas: ValidationSchemas<TBody, TParams, TQuery>,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const details: ErrorDetail[] = [];
    const valid: Record<string, unknown> = { body: undefined, params: undefined, query: undefined };

    for (const key of ['body', 'params', 'query'] as const) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (result.success) {
        valid[key] = result.data;
      } else {
        details.push(
          ...toDetails(result.error).map((detail) => ({
            ...detail,
            path: detail.path ? `${key}.${detail.path}` : key,
          })),
        );
      }
    }

    if (details.length > 0) {
      next(new BadRequestError('Request validation failed.', details));
      return;
    }

    // `req.query` is a getter-only property in Express 5, so validated values
    // are exposed on a separate `valid` bag rather than written back in place.
    (req as ValidatedRequest).valid = valid as ValidatedRequest['valid'];
    next();
  };
}
