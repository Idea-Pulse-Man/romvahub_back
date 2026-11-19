import type { Request } from 'express';
import { UnauthorizedError } from '../http/errors.js';
import type { UserRole } from './auth.schemas.js';

/**
 * Who is making a request, for the handlers whose answer depends on it.
 *
 * `currentUserId` remains the right thing to reach for wherever the answer is
 * "this account's rows and no others". This is for the places where an admin
 * legitimately sees or writes beyond their own account — the bid list, the
 * profile screen, user management — and the id alone can no longer decide.
 */
export interface Actor {
  id: string;
  role: UserRole;
  /** A Profile token's request: only this Profile's rows (see `bidAccessScope`). */
  profileId?: string;
}

export function currentActor(req: Request): Actor {
  if (!req.user) throw new UnauthorizedError('Authentication required.');
  return { id: req.user.id, role: req.user.role, ...(req.user.profileId ? { profileId: req.user.profileId } : {}) };
}

export function isAdmin(actor: Actor): boolean {
  return actor.role === 'admin';
}

/**
 * The owner filter for a query over user-owned rows: nothing for an admin, who
 * sees every profile's rows, and `userId` for everyone else.
 *
 * Spread into a `where` rather than returned as a whole clause, so the call
 * site reads as the query it is: `where: { ...ownerScope(actor), status }`.
 */
export function ownerScope(actor: Actor): { userId?: string } {
  return isAdmin(actor) ? {} : { userId: actor.id };
}

/**
 * The account a read or write is *about*, which is not always the one making
 * it. An admin may name any account; everyone else may only name their own,
 * and naming someone else's is treated as naming nobody.
 */
export function targetUserId(actor: Actor, requested: string | undefined): string {
  if (!requested || requested === actor.id) return actor.id;
  if (!isAdmin(actor)) throw new UnauthorizedError('You may only act on your own account.');
  return requested;
}
