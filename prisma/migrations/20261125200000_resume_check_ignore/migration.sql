-- The Resume check's ignore list: words and phrases that are never flagged.
CREATE TABLE "resume_check_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ignore" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_check_settings_pkey" PRIMARY KEY ("id")
);
