-- Add optimistic-concurrency version to Resource (issue #102).
-- Every resource update, delete (soft-delete), and rollback must supply the
-- version it read; the update only applies when the stored version still
-- matches, and increments it atomically. New rows start at 1.
ALTER TABLE "Resource" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Backfill existing rows to their latest immutable history version so the
-- new column stays in sync with ResourceVersion numbering (create = 1, each
-- mutation = +1). Resources without history keep the default of 1.
UPDATE "Resource" r
SET "version" = sub.max_version
FROM (
  SELECT "resourceId", MAX("version") AS max_version
  FROM "ResourceVersion"
  GROUP BY "resourceId"
) sub
WHERE r."id" = sub."resourceId";
