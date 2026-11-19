# Changelog

## Unreleased

- Add startup secret-provider health checks (issue #113): before serving traffic the API validates each configured secret provider (facilitator signer, event-stream signing secret) for reachability, key existence/metadata and required permissions, without signing production payloads and without logging secret material. A failed check blocks only the capability that requires that secret (fail closed) and is visible on `/ready` via the new `secretProviders` check.
- Add authenticated server-sent receipt status streams with signed per-receipt and per-seller
  grants, validated resume cursors, heartbeats, and bounded per-scope journals.
- Add official x402 v2 exact verification and settlement, durable payment evidence, reconciliation,
  catalog resources, MCP Streamable HTTP, operational probes, and release governance.

No backend release is declared deployed until the external exact-flow gate passes.
