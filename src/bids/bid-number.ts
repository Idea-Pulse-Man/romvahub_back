import type { Prisma as PrismaTypes } from '../generated/prisma/client.js';

/**
 * Where an application is filed, for the two things decided per filing scope:
 * its number and whether it is a duplicate. The application Profile when it
 * has one; otherwise the owner's legacy rows, the ones with no Profile.
 */
export interface BidScope {
  userId: string;
  profileId: string | null;
}

/** Every application in a filing scope. */
export function bidScopeWhere(scope: BidScope): PrismaTypes.BidWhereInput {
  return scope.profileId
    ? { profileId: scope.profileId }
    : { userId: scope.userId, profileId: null };
}

/**
 * Holds the scope for the rest of the transaction, so two saves arriving
 * together (the scraper extension saving several tabs) are checked and
 * numbered one after the other rather than both reading the same "before".
 * Taking it twice in one transaction is harmless.
 */
export async function lockBidScope(tx: PrismaTypes.TransactionClient, scope: BidScope): Promise<void> {
  const lockKey = scope.profileId ? `bids:profile:${scope.profileId}` : `bids:user:${scope.userId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}

/**
 * The number the next application filed in this scope gets: one past the
 * highest already there, starting at 1. Deleting an application therefore
 * leaves a gap rather than renumbering the ones filed after it.
 *
 * Call it inside the transaction that inserts the row; it takes the scope's
 * lock, so two inserts cannot be handed the same number.
 */
export async function nextBidNumber(tx: PrismaTypes.TransactionClient, scope: BidScope): Promise<number> {
  await lockBidScope(tx, scope);
  const { _max } = await tx.bid.aggregate({ where: bidScopeWhere(scope), _max: { number: true } });
  return (_max.number ?? 0) + 1;
}
