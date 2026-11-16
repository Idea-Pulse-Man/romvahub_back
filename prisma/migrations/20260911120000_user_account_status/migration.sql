-- Account lifecycle for platform Users: active (may sign in) or suspended
-- (blocked by an administrator). Defaults existing rows to active.

CREATE TYPE "user_account_status" AS ENUM ('active', 'suspended');

ALTER TABLE "users"
  ADD COLUMN "status" "user_account_status" NOT NULL DEFAULT 'active';
