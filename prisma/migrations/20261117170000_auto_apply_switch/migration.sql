-- Start apply / Stop on romva.space for the desktop agents.
ALTER TABLE "auto_make_state" ADD COLUMN "applyEnabled" BOOLEAN NOT NULL DEFAULT false;
