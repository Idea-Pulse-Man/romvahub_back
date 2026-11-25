-- Bidder / Caller dropped again: the roles are Super Admin, Admin and User.
ALTER TABLE "users" DROP COLUMN IF EXISTS "kind";
DROP TYPE IF EXISTS "user_kind";
