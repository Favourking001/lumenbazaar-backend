-- Add seller suspension state so enforcement can be centralized across the
-- API, MCP, and worker entry points. Existing sellers stay active.
ALTER TABLE "Seller" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "Seller" ADD COLUMN "suspendedAt" TIMESTAMP;
ALTER TABLE "Seller" ADD COLUMN "suspensionReason" TEXT;

CREATE INDEX "Seller_status_idx" ON "Seller" ("status");
