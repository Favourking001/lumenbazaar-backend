# AUDIT REPORT - Issue #111: Add Structured Public Error Catalog

## STEP 1 - AUDIT FINDINGS

### Typed Errors in `packages/shared/src/errors.ts`

22 error codes identified (all currently public):

1. `PAYMENT_REQUIRED` → 402
2. `UNSUPPORTED_NETWORK` → 400
3. `UNSUPPORTED_ASSET` → 400
4. `INVALID_PAYMENT_PAYLOAD` → 400
5. `INVALID_SIGNATURE` → 401
6. `AUTH_EXPIRED` → 400
7. `REPLAY_DETECTED` → 409
8. `AMOUNT_MISMATCH` → 400
9. `ASSET_MISMATCH` → 400
10. `RECIPIENT_MISMATCH` → 400
11. `SETTLEMENT_FAILED` → 502
12. `TRUSTLINE_REQUIRED` → 424
13. `RESOURCE_NOT_FOUND` → 404
14. `SELLER_NOT_FOUND` → 404
15. `SELLER_DOMAIN_UNVERIFIED` → 403
16. `CATALOG_VALIDATION_FAILED` → 400
17. `ROUTE_TEMPLATE_INVALID` → 400
18. `VALIDATION_FAILED` → 400
19. `RATE_LIMITED` → 429
20. `UNAUTHORIZED` → 401
21. `FORBIDDEN` → 403
22. `INTERNAL_ERROR` → 500

### Error Mapping (`packages/shared/src/errorMapping.ts`)

- `toPublicError()`: Redacts sensitive details matching pattern `/(secret|seed|private|token|signature|authorization|password|api[_-]?key)/i`
- `mapInfrastructureError()`: Maps Prisma unique constraint errors (P2002) to `REPLAY_DETECTED` or `VALIDATION_FAILED`
- `redactSensitiveDetails()`: Recursively redacts nested sensitive values
- `documentedErrorStatuses()`: Provides error code → HTTP status mapping

### OpenAPI Definitions (`apps/api/src/openapi.ts`)

- Central schema definition for error responses in `errorResponse` object:
  - Required fields: `ok: false`, `error.code`, `error.message`
  - Optional: `error.details`, `requestId`
- Error codes are NOT explicitly enumerated in OpenAPI
- No error catalog or documentation links present

### Analysis

**Public vs Internal**: All 22 codes are currently public (no internal-only classification)

**Duplicates**: None found

**Missing from OpenAPI**: All 22 codes lack explicit documentation in OpenAPI definitions

**Missing from Docs**: No error catalog docs exist in `docs/api/`

**Existing Build Scripts**:
- `pnpm openapi:check` - validates OpenAPI spec
- `pnpm openapi:generate` - generates OpenAPI spec from contracts
- Scripts located in `scripts/openapi.ts`

**Recommendation**: Leverage existing `scripts/openapi.ts` patterns for error catalog generation
