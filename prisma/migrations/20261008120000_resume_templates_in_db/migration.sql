-- Uploaded Resume Maker templates, stored in the database.
CREATE TABLE "resume_templates" (
    "id" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_templates_pkey" PRIMARY KEY ("id")
);
