-- A plain User is a Bidder or a Caller (same access; shown next to the role).
CREATE TYPE "user_kind" AS ENUM ('bidder', 'caller');
ALTER TABLE "users" ADD COLUMN "kind" "user_kind" NOT NULL DEFAULT 'bidder';
