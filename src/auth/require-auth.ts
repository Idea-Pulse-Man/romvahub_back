import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import type { UserRole } from './auth.schemas.js';
import { ACCESS_COOKIE } from './cookies.js';
import { verifyAccessToken } from './tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`; every route below it can rely on this existing. */
      user?: { id: string; email: string; role: UserRole };
    }
  }
}

/**
 * Reads the access token from the httpOnly cookie, falling back to a Bearer
 * header so that curl and the Swagger UI "Try it out" button remain usable.
 */
function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.[ACCESS_COOKIE];
  if (typeof cookieToken === 'string' && cookieToken.length > 0) return cookieToken;

  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null;

  return null;
}

export const requireAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const token = extractToken(req);
  if (!token) {
    next(new UnauthorizedError('Authentication required.'));
    return;
  }

  const payload = verifyAccessToken(token);
  req.user = { id: payload.sub, email: payload.email, role: payload.role };
  next();
};

/**
 * Admin-only routes. Mount below `requireAuth`, which is what puts the role on
 * the request — on its own this answers 401 rather than 403, because an
 * unauthenticated caller has no role to be forbidden by.
 */
export const requireAdmin: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) {
    next(new UnauthorizedError('Authentication required.'));
    return;
  }
  if (req.user.role !== 'admin') {
    next(new ForbiddenError('This action is restricted to administrators.'));
    return;
  }
  next();
};

/**
 * Narrows `req.user` for handlers mounted behind `requireAuth`. Throwing rather
 * than asserting keeps a routing mistake from silently leaking another user's
 * rows.
 */
export function currentUserId(req: Request): string {
  if (!req.user) throw new UnauthorizedError('Authentication required.');
  return req.user.id;
}

/** The same narrowing, for a handler that varies by role rather than refusing. */
export function currentUserRole(req: Request): UserRole {
  if (!req.user) throw new UnauthorizedError('Authentication required.');
  return req.user.role;
}
