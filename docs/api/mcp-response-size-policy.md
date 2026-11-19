# MCP response size and truncation policy

MCP tool results are serialized JSON sent over the Streamable HTTP
transport (and stdio). A large result can exhaust transport memory or be
truncated without machine-readable context. Every tool result is
therefore measured as UTF-8 JSON bytes against a per-tool budget before
it is returned. A result inside its budget is returned unchanged. An
oversized result is truncated **explicitly**: the returned value carries
a `truncation` object describing what happened, stays valid against the
tool's output schema, and the omitted remainder can be retrieved through
a cursor / artifact.

## Budgets

| Tool                      | Default budget |
| ------------------------- | -------------- |
| `list_supported_networks` | 16 KiB         |
| `search_paid_resources`   | 128 KiB        |
| `inspect_resource`        | 128 KiB        |
| `prepare_payment`         | 32 KiB         |
| `call_paid_resource`      | 256 KiB        |
| `get_payment_receipt`     | 64 KiB         |
| `inspect_budget`          | 16 KiB         |
| `get_response_artifact`   | 128 KiB        |

Budgets are configurable without code changes:

- `MCP_RESPONSE_MAX_BYTES` — default budget for tools without an override.
- `MCP_RESPONSE_MAX_BYTES_<TOOL>` — per-tool override, e.g.
  `MCP_RESPONSE_MAX_BYTES_SEARCH_PAID_RESOURCES=65536`. Invalid or
  non-positive values fall back to the defaults.
- `MCP_RESPONSE_ARTIFACT_MAX_BYTES` — largest remainder the artifact
  store accepts (default 1 MiB).
- `MCP_RESPONSE_ARTIFACT_TTL_MS` — how long an artifact stays
  retrievable (default 10 minutes).
- `MCP_RESPONSE_ARTIFACT_MAX_ENTRIES` — most artifacts held in memory
  (default 100, oldest evicted first).
- `MCP_RESPONSE_CHUNK_BYTES` — maximum size of one streamed JSON chunk
  (default 16 KiB).

The policy lives in `packages/shared/src/mcpResponsePolicy.ts`
(`resolveMcpResponsePolicy`, `budgetForTool`,
`applyMcpResponsePolicy`) and is enforced in
`apps/mcp-server/src/server.ts` for every tool call, after the result
has validated against the tool's output schema and again afterwards,
so a truncated result is always schema-valid.

## Truncation metadata

A truncated result carries a `truncation` object alongside its normal
fields:

```json
{
  "resources": ["<kept prefix>"],
  "truncation": {
    "truncated": true,
    "tool": "search_paid_resources",
    "budgetBytes": 131072,
    "originalBytes": 1048576,
    "truncatedBytes": 130844,
    "omittedItems": 18,
    "omittedBytes": 917732,
    "droppedFields": ["debugPayload"],
    "artifactId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "cursor": "eyJ2IjoxLCJhcnRpZmFjdElkIjoiLi4uIiwidG9vbCI6InNlYXJjaF9wYWlkX3Jlc291cmNlcyIsIm9mZnNldCI6MH0",
    "reason": "response_exceeds_budget"
  }
}
```

- `originalBytes` / `truncatedBytes` are the UTF-8 JSON sizes before and
  after truncation; `truncatedBytes` is always within `budgetBytes`.
- `omittedItems` counts dropped array items; `omittedBytes` is their
  serialized size plus dropped fields and truncated string tails.
- `droppedFields` lists the dot paths of whole non-evidence fields that
  were removed.
- `artifactId` / `cursor` reference the omitted remainder (absent when
  the remainder was too large to store).

Truncation shrinks in this order: trailing array items, long
non-evidence strings (kept prefix only), then whole non-evidence
object fields, largest first. Small scalars and payment evidence are
never shrunk.

## Cursor / artifact retrieval

Call the local `get_response_artifact` tool with the `artifactId`
from the truncation object (and `offset` / `limit`, default 0 / 20,
maximum 100) to page through the omitted entries:

```json
{
  "artifactId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "tool": "search_paid_resources",
  "storedAt": 1792459200000,
  "truncated": true,
  "totalOmitted": 18,
  "hasMore": true,
  "items": [{ "path": "resources", "kind": "array-item", "value": {} }],
  "nextCursor": "eyJ2IjoxLC4uLn0"
}
```

Each item records the dot path it came from, its kind
(`array-item`, `field`, or `string-tail`), and its original value.
`nextCursor` is an opaque base64url cursor encoding the artifact id,
tool, and next offset; pass its offset into the next call, or decode
it with `decodeTruncationCursor`. Artifacts expire after the
configured TTL and unknown or expired ids return
`RESOURCE_NOT_FOUND`. For `search_paid_resources` the truncation
cursor is separate from the backend pagination cursor in `cursor`:
the backend cursor pages the catalog, the truncation cursor pages the
omitted remainder of one already-returned page.

## Payment evidence is never silently removed

Payment evidence — a `receipt`, `settlement`, or `payment` object and
its scalar keys (`transactionHash`, `paymentHash`, `correlationId`,
`evidenceHash`, `receiptId`, `paymentAttemptId`, `ledger`) — is
preserved verbatim even when everything else is truncated away. When
the evidence alone exceeds the tool's budget, the call fails
explicitly with `RESPONSE_TOO_LARGE` (including `tool`,
`budgetBytes`, `evidenceBytes`, and `originalBytes` in the error
details) instead of returning a result with the evidence dropped.

## Streamed responses

Tool results travel over the Streamable HTTP transport, so truncation
happens before streaming and the streamed text is the truncated JSON.
`chunkJsonText` / `streamJsonChunks` in
`packages/shared/src/mcpResponsePolicy.ts` split serialized JSON into
chunks of at most `MCP_RESPONSE_CHUNK_BYTES` UTF-8 bytes without
splitting a character; joining the chunks reproduces the truncated
JSON exactly, with its `truncation` metadata intact.

## Errors

- `RESPONSE_TOO_LARGE` — payment evidence alone exceeds the tool's
  response budget; the call fails rather than dropping evidence.
  Reduce the evidence size or raise the tool's budget.
- `RESOURCE_NOT_FOUND` — `get_response_artifact` was called with an
  unknown or expired artifact id.

## Where the rules live

- Policy, budgets, truncation, cursors, artifact store, chunking:
  `packages/shared/src/mcpResponsePolicy.ts`
  (`applyMcpResponsePolicy`, `McpResponseArtifactStore`,
  `chunkJsonText`, `serializeTruncatedJsonStream`).
- Enforcement and the artifact tool: `apps/mcp-server/src/server.ts`,
  `apps/mcp-server/src/tools.ts` (`mcpTruncationSchema`,
  `get_response_artifact`).
- Error: `apps/mcp-server/src/errors.ts` (`ResponseTooLargeError`,
  code `RESPONSE_TOO_LARGE`).
- Tests: `packages/shared/src/mcpResponsePolicy.test.ts` (budgets,
  JSON boundaries, evidence, cursors/artifacts, chunking) and
  `apps/mcp-server/src/responsePolicy.test.ts` (live Streamable HTTP
  calls, artifact paging, evidence over the wire).

No database migration is involved: artifacts live only in memory for
the configured TTL, and MCP tool responses are not part of the REST
OpenAPI document (`docs/api/openapi.json`).
