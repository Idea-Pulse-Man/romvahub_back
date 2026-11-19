-- The Super Admin (with an authenticator app), and the Profile tokens it makes
-- for the extension and the agent.
ALTER TABLE "users" ADD COLUMN "superAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "users" ADD COLUMN "totpEnabledAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "totpLastStep" INTEGER;

CREATE TABLE "profile_tokens" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "profile_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "profile_tokens_tokenHash_key" ON "profile_tokens"("tokenHash");
CREATE INDEX "profile_tokens_profileId_idx" ON "profile_tokens"("profileId");

ALTER TABLE "profile_tokens" ADD CONSTRAINT "profile_tokens_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "profile_tokens" ADD CONSTRAINT "profile_tokens_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "login_challenges" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "setup" BOOLEAN NOT NULL DEFAULT false,
    "totpSecret" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "login_challenges_userId_idx" ON "login_challenges"("userId");

ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- support@romva.space is the Super Admin (and so an admin), when the account exists.
UPDATE "users" SET "superAdmin" = true, "role" = 'admin' WHERE lower("email") = 'support@romva.space';
