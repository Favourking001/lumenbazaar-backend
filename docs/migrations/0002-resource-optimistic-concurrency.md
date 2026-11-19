# Resource optimistic concurrency migration

Migration `0002_resource_optimistic_concurrency` adds a `version` column to
`Resource` for optimistic concurrency (issue #102).

## What changed

- `Resource.version` (`INTEGER NOT NULL DEFAULT 1`): starts at 1 on create
  and increments atomically on every update, delete (soft-delete), and
  rollback.
- Existing rows are backfilled to their latest immutable `ResourceVersion`
  number, so the new column stays in sync with version history (create = 1,
  each mutation = +1). Resources without history keep the default of 1.

## Behavior

- `PATCH /v1/resources/:id`, `DELETE /v1/resources/:id`, and
  `POST /v1/resources/:id/rollback` require the version the caller read,
  sent as the `If-Match` header (`If-Match: "3"`, or bare `If-Match: 3`) or,
  for updates, as the `version` field of the request body. The header wins
  when both are sent.
- The mutation applies only while the stored version still matches, via a
  single conditional update (`UPDATE ... WHERE id = ? AND version = ?` with
  `version = version + 1`). A stale write is rejected with
  `409 RESOURCE_VERSION_CONFLICT`, whose details carry `expectedVersion` and
  `currentVersion` so the caller can re-read and retry. No version is ever
  written from a request body: the store increments it.
- A mutation with no precondition at all is rejected with
  `400 VALIDATION_FAILED`.

## Upgrade

1. Back up the PostgreSQL database.
2. Stop API instances that can mutate resources.
3. Run `pnpm prisma migrate deploy`.
4. Run `pnpm prisma:validate`, start one API instance, and verify `/ready`.
5. Restore normal API and worker capacity.

## Rollback

Application rollback is safe only before new rows depend on the column.
Stop writers, restore the pre-migration application, then drop the
`version` column from `Resource`. For any production traffic after the
upgrade, restore the pre-upgrade database backup instead.
