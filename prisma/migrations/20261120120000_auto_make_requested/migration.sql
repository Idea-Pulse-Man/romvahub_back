-- "Make" clicked on an application in the table: the automatic maker takes it
-- before every other waiting application.
ALTER TABLE "auto_make_claims" ADD COLUMN "requestedAt" TIMESTAMP(3);
