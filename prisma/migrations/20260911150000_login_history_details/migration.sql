-- Richer login audit: location (GeoIP) and parsed client details.

ALTER TABLE "login_history"
  ADD COLUMN "acceptLanguage" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "countryCode" TEXT,
  ADD COLUMN "region" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "isp" TEXT,
  ADD COLUMN "org" TEXT,
  ADD COLUMN "locationLabel" TEXT,
  ADD COLUMN "browser" TEXT,
  ADD COLUMN "os" TEXT,
  ADD COLUMN "deviceType" TEXT;
