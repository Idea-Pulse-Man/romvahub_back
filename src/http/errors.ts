/**
 * Every error the API returns deliberately has the same JSON envelope:
 *
 *   { "error": { "code": "...", "message": "...", "details": [...] } }
 *
 * so the frontend can branch on `code` without string-matching prose.
 */
export interface ErrorDetail {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetail[] | undefined;
  /**
   * What the client needs to act on the refusal, when a message and a list
   * of field problems are not it — the applications a refused screenshot
   * duplicates, say. Serialised as `error.data`; absent for most errors.
   */
  readonly data: unknown;

  constructor(status: number, code: string, message: string, details?: ErrorDetail[], data?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.data = data;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: ErrorDetail[]) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource.') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

/**
 * A refresh token presented again moments after it was rotated: two tabs (or
 * two requests) renewed the session at once, and the other one already won.
 * Not theft, so nothing is revoked and the cookies are left alone; the client
 * retries its request with the cookie the winner set.
 */
export class RefreshRaceError extends AppError {
  constructor() {
    super(409, 'REFRESH_RACE', 'The session was just renewed by another tab. Retry the request.');
  }
}

/**
 * The profile already has this application: the same posting (by link) or
 * another posting at the same employer. romva.space refuses it rather than
 * filing a second one, whoever sends it — the website's form or the scraper
 * extension. `data.reason` says which rule matched and `data.matches` names the
 * existing applications, so a client can show or open them.
 */
export class DuplicateApplicationError extends AppError {
  constructor(message: string, reason: 'job-url' | 'company', matches: unknown[]) {
    super(409, 'DUPLICATE_APPLICATION', message, undefined, { reason, matches });
  }
}

/**
 * The screenshot is already on one of the profile's other applications, so
 * it is not stored: every application needs its own confirmation page. The
 * matches travel in `data` so the form can show which and open them.
 */
export class DuplicateProofError extends AppError {
  constructor(message: string, matches: unknown[]) {
    super(409, 'DUPLICATE_PROOF', message, undefined, { matches });
  }
}

/**
 * Syntactically valid but semantically rejected — used for the business rules
 * in README §4, most notably "an interview stage cannot be entered without a
 * scheduled date and time".
 */
export class UnprocessableEntityError extends AppError {
  constructor(message: string, details?: ErrorDetail[]) {
    super(422, 'UNPROCESSABLE_ENTITY', message, details);
  }
}

/**
 * The request was fine, but something the API depends on and does not control
 * failed — fetching a job posting from a third-party site, or an AI platform
 * refusing or garbling a Resume.
 */
export class BadGatewayError extends AppError {
  constructor(message: string) {
    super(502, 'BAD_GATEWAY', message);
  }
}

/**
 * An upstream call ran past the budget this function has to answer in.
 *
 * Distinct from a 502: nothing failed and nothing was refused — the platform
 * was still thinking when we ran out of time. The distinction matters to the
 * reader, because the fix is a faster model or a longer timeout rather than
 * anything about the request.
 */
export class GatewayTimeoutError extends AppError {
  constructor(message: string) {
    super(504, 'GATEWAY_TIMEOUT', message);
  }
}

/**
 * The request was fine and the feature exists, but this deployment has not been
 * configured to serve it — an AI provider with no API key set. Distinct from a
 * 502: nothing failed, something was never switched on.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(503, 'SERVICE_UNAVAILABLE', message);
  }
}

/**
 * A refresh token that was already rotated, presented again after the race
 * window: refused, but the session cookies are left as they are, since the
 * browser may already hold the newer one.
 */
export class StaleRefreshError extends UnauthorizedError {
  constructor() {
    super('This session was renewed elsewhere. Reload the page; sign in again only if that does not help.');
  }
}
