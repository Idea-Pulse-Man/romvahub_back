import type { CookieOptions, Response } from 'express';
import { env } from '../env.js';

export const ACCESS_COOKIE = 'ge_access';
export const REFRESH_COOKIE = 'ge_refresh';

/**
 * Both tokens travel as httpOnly cookies so that no script on the page can read
 * them — the reason for choosing cookies over `Authorization` headers with
 * client-side storage.
 *
 * `SameSite=Lax` is the default and is enough while the API and the app share a
 * site — which is how the frontend deploys, proxying `/api` through its own
 * origin. Running them on genuinely different origins needs
 * `COOKIE_SAMESITE=none` (and therefore `Secure`, which `env.ts` enforces),
 * plus CSRF protection beyond SameSite — see README §7.
 */
function baseOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.COOKIE_SAMESITE,
    path: '/',
    maxAge: maxAgeMs,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

/** Parses `15m` / `2h` / `900s` / `900` into milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported duration: "${value}"`);

  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1000;
  return amount * scale;
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE, accessToken, baseOptions(parseDuration(env.ACCESS_TOKEN_TTL)));
  res.cookie(
    REFRESH_COOKIE,
    refreshToken,
    // Scoped to the auth routes so it is never sent on ordinary API traffic.
    {
      ...baseOptions(env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      path: '/api/auth',
    },
  );
}

export function clearAuthCookies(res: Response): void {
  const { maxAge: _access, ...accessOptions } = baseOptions(0);
  const { maxAge: _refresh, ...refreshOptions } = baseOptions(0);
  res.clearCookie(ACCESS_COOKIE, accessOptions);
  res.clearCookie(REFRESH_COOKIE, { ...refreshOptions, path: '/api/auth' });
}
