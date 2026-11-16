-- Successful sign-in audit trail for admin user management.

CREATE TABLE "login_history" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "login_history_userId_createdAt_idx" ON "login_history"("userId", "createdAt" DESC);

ALTER TABLE "login_history"
  ADD CONSTRAINT "login_history_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
