-- The automatic maker's direction on romva.space: up (No 1 first) or down
-- (the highest number first, from the top it had when Down was chosen).
ALTER TABLE "auto_make_state" ADD COLUMN "makeOrder" TEXT NOT NULL DEFAULT 'up';
ALTER TABLE "auto_make_state" ADD COLUMN "downFrom" TIMESTAMP(3);
