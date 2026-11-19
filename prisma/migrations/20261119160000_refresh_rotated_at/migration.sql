-- When a refresh token was rotated, so two tabs renewing at once are not taken for theft.
ALTER TABLE "refresh_tokens" ADD COLUMN "rotatedAt" TIMESTAMP(3);
