import { Router, type Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../env.js';
import { RefreshRaceError, StaleRefreshError, UnauthorizedError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { LoginSchema, MfaVerifySchema, type LoginInput, type MfaVerifyInput } from './auth.schemas.js';
import * as authService from './auth.service.js';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from './cookies.js';
import * as profileTokens from './profile-tokens.js';
import { currentUserId, requireAuth } from './require-auth.js';

export const authRouter: Router = Router();

/**
 * Credential endpoints are the one place worth rate-limiting hard: they are the
 * only routes where guessing is useful. Disabled under `NODE_ENV=test` so the
 * suite can sign many users in without tripping it.
 *
 * There is no public registration — accounts are created by an administrator
 * (`POST /api/admin/users`) or by `yarn admin` for the sole admin.
 */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Wrong passwords (or authenticator codes) only, per account and address: a
  // team behind one office connection all signing in again at once used to
  // share one budget of 30 and lock everyone out for minutes, right ones too.
  limit: env.NODE_ENV === 'production' ? 10 : 200,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const body = (req.body ?? {}) as { email?: unknown; challengeId?: unknown };
    const who = typeof body.email === 'string' ? body.email.trim().toLowerCase() : String(body.challengeId ?? '');
    return `${ipKeyGenerator(req.ip ?? '')}|${who}`;
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many wrong passwords for this account. Please try again in 15 minutes.',
    },
  },
});

authRouter.post('/login', credentialLimiter, validate({ body: LoginSchema }), async (req, res) => {
  const { email, password } = (req as ValidatedRequest<LoginInput>).valid.body;
  const result = await authService.login(email, password, loginContext(req));
  // The Super Admin: the password was right, and the authenticator code comes next.
  if ('mfa' in result) {
    res.json(result);
    return;
  }
  const { user, accessToken, refreshToken } = result;
  setAuthCookies(res, accessToken, refreshToken);
  res.json({ user, accessToken, refreshToken });
});

/** The authenticator code for a sign-in `/login` answered with `{ mfa }`. */
authRouter.post('/login/verify', credentialLimiter, validate({ body: MfaVerifySchema }), async (req, res) => {
  const { challengeId, code } = (req as ValidatedRequest<MfaVerifyInput>).valid.body;
  const { user, accessToken, refreshToken } = await authService.verifyMfa(challengeId, code, loginContext(req));
  setAuthCookies(res, accessToken, refreshToken);
  res.json({ user, accessToken, refreshToken });
});

function loginContext(req: Request): authService.LoginContext {
  return { ip: req.ip, userAgent: req.get('user-agent'), acceptLanguage: req.get('accept-language') };
}

authRouter.post('/refresh', async (req, res) => {
  // Cookie first (website); JSON body next (extension / API clients that
  // cannot rely on a path-scoped refresh cookie).
  const fromCookie = req.cookies?.[REFRESH_COOKIE];
  const fromBody =
    req.body && typeof req.body === 'object' && typeof (req.body as { refreshToken?: unknown }).refreshToken === 'string'
      ? (req.body as { refreshToken: string }).refreshToken
      : '';
  const presented =
    typeof fromCookie === 'string' && fromCookie.length > 0
      ? fromCookie
      : fromBody.trim();

  if (!presented) {
    throw new UnauthorizedError('No refresh token supplied.');
  }

  try {
    const { user, accessToken, refreshToken } = await authService.refresh(presented);
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ user, accessToken, refreshToken });
  } catch (error) {
    // Another tab renewed the session a moment ago: its new cookies are the
    // good ones, so they are kept, and the caller retries with them.
    if (error instanceof RefreshRaceError) throw error;
    // A refresh that cannot succeed should not leave a stale cookie behind to
    // be retried on every subsequent request. Only a refusal (401) means that:
    // a server or database failure (500, "max clients reached") keeps the
    // cookies, so the session survives and the next try renews it, rather than
    // every signed-in person being sent to the sign-in page at once.
    if (error instanceof UnauthorizedError && !(error instanceof StaleRefreshError)) clearAuthCookies(res);
    throw error;
  }
});

authRouter.post('/logout', async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  clearAuthCookies(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  // A Profile token (the extension, the agent): which Profile it acts as.
  if (req.user?.profileId) {
    res.json({ token: await profileTokens.describeToken(req.user.tokenId ?? '') });
    return;
  }
  res.json({ user: await authService.getUser(currentUserId(req)) });
});
