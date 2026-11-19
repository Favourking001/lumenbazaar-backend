# Horizon Pagination Exhaustion Guard

Horizon history endpoints (`transactions`, `operations`, `payments`,
`effects`) are paginated through `_links.next` URLs. A malformed or
unexpectedly large traversal — a `next` link that cycles, an endless
stream of empty pages, or a collection far larger than the caller
expects — could otherwise issue unbounded reconciliation requests.
`packages/stellar-payments/src/horizonFinality.ts` bounds every
traversal so it always terminates.

## Budgets

Each traversal is bounded by page count, unique record count, and
wall-clock duration. The defaults are:

| Budget              | Default   | Env var                             | Hard limit        |
| ------------------- | --------- | ----------------------------------- | ----------------- |
| Max pages           | 100       | `HORIZON_TRAVERSAL_MAX_PAGES`       | 10 000            |
| Max records         | 1000      | `HORIZON_TRAVERSAL_MAX_RECORDS`     | 100 000           |
| Max duration        | 30 000 ms | `HORIZON_TRAVERSAL_MAX_DURATION_MS` | 600 000 ms        |
| Page size (`limit`) | 100       | — (per-call override only)          | 200 (Horizon cap) |

Budgets resolve in this order: per-call override, deployment config
(`config.settlement.horizonTraversal`), defaults. An invalid budget
(non-positive, non-integer, or above the hard limit) fails closed with
a `LumenError` instead of being silently clamped.

## Behaviour on exhaustion

When a budget is reached the traversal stops cleanly and the result
reports `completed: false` with an `exhaustedReason`:

- `page_budget` — the page count was reached with pages still unfetched.
- `record_budget` — the unique record count was reached with pages still unfetched.
- `duration_budget` — the wall-clock duration was reached.
- `cyclic_next_link` — a `next` URL was already fetched. Resuming from
  the returned cursor re-detects the cycle before any further fetch.

Empty pages count against the page budget, so an endless stream of
empty pages terminates at the page budget; an empty final page (no
`next` link) completes normally.

## Resumable cursors

An incomplete result carries a serializable `resumeCursor` with the
next unfetched URL, the ids of records already returned, the URLs
already fetched, and the counts so far. Passing it to a later
`traverseHorizonHistory` call continues where the previous traversal
stopped: already-processed records are skipped (never returned or
counted twice) and already-fetched URLs are never re-requested.

## Observability

Every result carries `metrics` (`pagesFetched`, `recordsFetched`,
`duplicateRecordsSkipped`, `emptyPages`, `durationMs`, `completed`,
`exhaustedReason`). The same snapshot is reported to the optional
`onProgress` callback after every page and at the end, and the optional
`logger` receives a final summary line.

## Testing

`packages/stellar-payments/src/horizonFinality.test.ts` stubs every
Horizon response deterministically — no live network, no real account
data — and covers cyclic `next` links (including self-referencing and
resume-from-cycle), empty pages, all three budget exhaustion reasons,
cursor resume without duplication, config defaults/overrides, and
malformed pages failing closed.
