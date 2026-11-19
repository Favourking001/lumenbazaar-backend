# Search query cost and result limits

Discovery queries (`GET /v1/discovery/search` and `GET /v1/discovery/resources`)
are validated against a deterministic cost model **before** any database work
runs. An over-budget or oversized query is rejected with an actionable error
instead of consuming an expensive scan and returning a silently truncated page.
The same rules are enforced client-side by the buyer SDK
(`packages/buyer-sdk/src/search.ts`), so an over-limit query fails fast
without a round trip.

## Cost model

Every query starts with a base cost of 1, plus:

| Component                                                                                        | Cost |
| ------------------------------------------------------------------------------------------------ | ---- |
| Base cost per query                                                                              | 1    |
| Each free-text query term (`q`, split on non-alphanumeric characters)                            | 2    |
| Each active filter (`network`, `asset`, `type`, `sellerId`, `minPrice`, `maxPrice`, `extension`) | 2    |
| Each block of up to 10 requested results (`limit`)                                               | 1    |

The model is a pure function of the request
(`estimateSearchQueryCost` in `packages/shared/src/searchLimits.ts`): the
same query always produces the same cost, independent of database state.

Maximum query cost: **50**.

Example: `q=weather forecast`, `network=stellar:testnet`, `type=http`,
`limit=20` costs 1 + (2 terms × 2) + (2 filters × 2) + ceil(20 / 10) = **11**.

## Caps

| Cap                                   | Value            | Error                          |
| ------------------------------------- | ---------------- | ------------------------------ |
| Maximum query cost                    | 50               | `QUERY_TOO_COMPLEX` (422)      |
| Maximum free-text query terms         | 20               | `QUERY_TOO_COMPLEX` (422)      |
| Maximum free-text query length        | 200 characters   | `QUERY_TOO_COMPLEX` (422)      |
| Maximum page size (`limit`)           | 100 (default 25) | `PAGE_SIZE_EXCEEDED` (400)     |
| Maximum candidates scored per search  | 100              | — (internal cap, not an error) |
| Maximum result window (cursor paging) | 1000 results     | `RESULT_WINDOW_EXCEEDED` (400) |

Notes:

- `limit` values below the maximum keep the previous behaviour: missing,
  non-numeric, or out-of-range values fall back to the default page size of
  25 (minimum 1). Only a `limit` above 100 is rejected.
- Search scores at most 100 candidate resources per request, regardless of
  the requested page size.
- Browse cursors carry the number of results already returned (`depth`). A
  cursor at or beyond 1000 returned results is rejected; narrow the filters
  instead of paging further. Cursors issued before this change carry no depth
  and keep working.
- The error response carries the offending values in `error.details`
  (`cost`, `maxCost`, `termCount`, `filterCount`, `limit`, `breakdown`,
  `requestedLimit`, or `depth`), so the caller can fix the query without
  guessing.

## Errors

All three errors use the standard failure envelope
(`{ ok: false, error: { code, message, details }, requestId }`):

- `QUERY_TOO_COMPLEX` (422) — "Search query cost 59 exceeds the maximum
  budget of 50. Remove filters, shorten the query, or request fewer results
  per page."
- `PAGE_SIZE_EXCEEDED` (400) — "Requested page size 500 exceeds the maximum
  page size of 100. Reduce limit to 100 or less."
- `RESULT_WINDOW_EXCEEDED` (400) — "Result window of 1000 results exceeded.
  Narrow the filters instead of paging further."

## Where the rules live

- Cost model and enforcement: `packages/shared/src/searchLimits.ts`
  (`estimateSearchQueryCost`, `assertSearchQueryWithinLimits`).
- Error codes and HTTP statuses: `packages/shared/src/errors.ts`
  (`QUERY_TOO_COMPLEX`, `PAGE_SIZE_EXCEEDED`, `RESULT_WINDOW_EXCEEDED`).
- Page size and result window constants: `packages/shared/src/pagination.ts`
  (`maxPageLimit`, `maxResultWindow`).
- API enforcement: `apps/api/src/services/search.ts` (search) and
  `apps/api/src/services/discovery.ts` (browse), both before the resource
  store is called; `apps/api/src/services/resources.ts` enforces the result
  window when listing resources.
- Buyer SDK enforcement: `packages/buyer-sdk/src/search.ts`
  (`searchResources` validates before fetching and surfaces the API's error
  code and message when the server rejects a query).
- OpenAPI query parameters, including the caps, are declared in
  `apps/api/src/openapi.ts` and generated into `docs/api/openapi.json`.
