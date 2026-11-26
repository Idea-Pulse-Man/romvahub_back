-- Resumes kept as the AI's JSON: the Word and PDF files become copies in the
-- Resume folder on the server, built again from the JSON when one is missing.
ALTER TABLE "bids" ADD COLUMN "resumeAnswer" JSONB,
ADD COLUMN "resumeBuild" JSONB,
ADD COLUMN "resumeKept" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "backedUpAt" TIMESTAMP(3);

-- Every template version a Resume was made with, by the hash of its bytes.
CREATE TABLE "resume_template_versions" (
    "sha256" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_template_versions_pkey" PRIMARY KEY ("sha256")
);

-- Server-wide settings (one row): the Resume folder.
CREATE TABLE "server_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "resumeFolder" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "server_settings_pkey" PRIMARY KEY ("id")
);

-- "Backup and remove" on the Storage page.
CREATE TABLE "content_backups" (
    "id" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "filter" JSONB NOT NULL,
    "bidIds" UUID[],
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "content_backups_pkey" PRIMARY KEY ("id")
);
