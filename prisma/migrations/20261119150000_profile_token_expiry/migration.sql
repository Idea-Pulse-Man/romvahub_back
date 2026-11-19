-- Profile tokens expire: chosen when the token is made (7 days to a year).
ALTER TABLE "profile_tokens" ADD COLUMN "expiresAt" TIMESTAMP(3);
