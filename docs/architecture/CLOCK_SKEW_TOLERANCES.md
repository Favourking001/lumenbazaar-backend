# Clock-Skew Tolerances and Error Distinction

**Issue:** #115 - Add clock-skew verification test matrix

## Overview

This document specifies the clock-skew tolerances, error types, and deterministic test coverage for all time-based protocol decisions in LumenBazaar. Payment expiry, signature timestamps, and webhook timing can behave incorrectly when service clocks differ. This document defines the tolerances, error kinds, and validation procedures.

## Error Types

All time-based validation must distinguish three error cases:

### 1. **Stale** (Too Old / Expired)

Timestamp is older than the acceptable window for the operation.

**Examples:**
- Webhook signature is outside the 5-minute replay window
- Payment authorization has expired
- Receipt evidence is older than expected

**HTTP Status:** 400 Bad Request  
**Error Code:** `STALE_TIMESTAMP` or operation-specific code (e.g., `STALE_WEBHOOK`)  
**User Action:** Retry with current timestamp

**Implementation:** Compare age against explicit window constant. If `(now - timestamp) > window`, reject as stale.

---

### 2. **Future** (Timestamp Ahead of Verifier)

Timestamp is in the future beyond acceptable tolerance.

**Examples:**
- Webhook signature has a timestamp ahead of the verifier's clock
- Payment signed with a future timestamp
- Settlement receipt predates the settlement

**HTTP Status:** 400 Bad Request  
**Error Code:** `FUTURE_TIMESTAMP` or operation-specific code (e.g., `FUTURE_WEBHOOK`)  
**User Action:** Verify sender's clock is synchronized; retry if sender corrects time

**Implementation:** Check if `(timestamp - now) > tolerance`. If true, reject as future.

---

### 3. **Indeterminate** (Cannot Determine or Invalid - Fail Closed)

Timestamp cannot be parsed, is missing, malformed, non-numeric, out-of-range, or cryptographic verification failed. **This category MUST fail closed** (reject).

**Examples:**
- Timestamp field is missing
- Timestamp is `NaN` or `null`
- Timestamp is not valid ISO 8601
- Signature does not match (could be tampering or clock skew)
- Signature format is invalid (not hex-encoded)

**HTTP Status:** 400 Bad Request  
**Error Code:** `INVALID_TIMESTAMP` or `SIGNATURE_VERIFICATION_FAILED`  
**User Action:** Verify request format and sender implementation

**Implementation:** Any parsing error, missing value, or unrecoverable validation error → reject as indeterminate.

---

## Time-Based Protocol Decisions

### Webhook Timestamp Validation

**Window:** 5 minutes (300 seconds)

**Location:** `packages/shared/src/webhooks.ts::verifyWebhookSignature()`

**Clock Injection:** Optional `clock` parameter (defaults to real `Date.now()`)

**Logic:**
```
1. Parse timestamp from ISO 8601 string
   - If parse fails → INDETERMINATE (fail closed)
   
2. Calculate age: (now - timestamp_ms) / 1000
   - If age < 0 → FUTURE
   - If age > 300 → STALE
   - Else → ACCEPT
   
3. Verify HMAC-SHA256 signature (constant-time comparison)
   - If signature fails → INDETERMINATE (fail closed)
   - Else → signature valid + timestamp window valid = ACCEPT
```

**Test Matrix:**
- Zero skew: timestamp now, just before, just after window
- Positive skew (verifier ahead): at boundary, 1ms inside, 1ms outside
- Negative skew (verifier behind): timestamp appears future
- Malformed: missing, invalid ISO, NaN, empty string
- Signature mismatch (indeterminate, not stale)

**Boundary Constants:**
```typescript
const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
const WINDOW_MS = WEBHOOK_REPLAY_WINDOW_SECONDS * 1000; // 300,000 ms
const AT_BOUNDARY = WINDOW_MS;
const ONE_MS_INSIDE = WINDOW_MS - 1;
const ONE_MS_OUTSIDE = WINDOW_MS + 1;
```

---

### Payment Authorization Expiry

**Location:** `packages/stellar-payments/src/paymentPayload.ts`

**Status:** Not yet instrumented with injectable clock (Issue #115 phase 2).

**Future Work:**
- Add optional `clock` parameter to verification functions
- Add explicit expiry window constant
- Add test matrix for authorization expiry

---

### Receipt Evidence Verification

**Location:** `packages/stellar-payments/src/receiptVerification.ts`

**Status:** Uses fixed evidence encoding; no time-dependent validation logic currently.

**Future Work:**
- If evidence timestamps are added, add clock injection and test matrix

---

### Payment Attempt and Settlement Status Checks

**Locations:**
- `packages/stellar-payments/src/settlement.ts`
- `packages/stellar-payments/src/verification.ts`

**Status:** Current logic does not use system time for business decisions (uses database-stored timestamps).

**Future Work:**
- If settlement reconciliation adds time-based SLAs, add clock injection and test matrix

---

## Clock Injection Patterns

All production code must accept an **optional, injectable clock parameter** for testing:

```typescript
/**
 * @param clock - Optional injected clock for testing (defaults to real Date.now())
 */
export function myTimeBasedFunction(
  input: SomeType,
  clock?: Clock
): Result {
  const now = clock?.now() ?? Date.now();
  // ... use 'now' for all time decisions
}
```

**No global fake timers (e.g., `vi.useFakeTimers()`)** unless required by third-party libraries.

**Always provide a default** to avoid changing existing behavior:
```typescript
const now = clock?.now() ?? Date.now();
```

---

## Test Matrix Pattern

For each time-based decision, create a table-driven test:

```typescript
const testCases = [
  // Zero skew
  { name: "zero skew, timestamp now", clockOffsetMs: 0, expectedValid: true },
  
  // Positive skew (verifier ahead)
  { 
    name: "positive skew, at boundary", 
    clockOffsetMs: WINDOW_MS,
    expectedValid: false,
    expectedErrorType: "stale"
  },
  { 
    name: "positive skew, 1ms inside boundary",
    clockOffsetMs: WINDOW_MS - 1,
    expectedValid: true
  },
  { 
    name: "positive skew, 1ms outside boundary",
    clockOffsetMs: WINDOW_MS + 1,
    expectedValid: false,
    expectedErrorType: "stale"
  },
  
  // Negative skew (verifier behind)
  {
    name: "negative skew, timestamp in future",
    clockOffsetMs: -5000,
    expectedValid: false,
    expectedErrorType: "future"
  },
  
  // Invalid cases
  { 
    name: "malformed timestamp",
    timestamp: "not-a-date",
    expectedValid: false,
    expectedErrorType: "indeterminate"
  },
];

testCases.forEach(({name, clockOffsetMs, expectedValid, expectedErrorType}) => {
  it(`handles: ${name}`, () => {
    const clock = createFakeClock(Date.now() + clockOffsetMs);
    const result = myFunction(..., clock);
    
    expect(result.valid).toBe(expectedValid);
    if (!expectedValid) {
      expect(result.errorType).toBe(expectedErrorType);
    }
  });
});
```

---

## Validation Procedures

### Unit Tests

All time-based functions must have:
- Test for zero skew
- Test for positive skew at, inside, and outside boundary
- Test for negative skew (future detection)
- Test for all malformed/indeterminate cases
- Assertions on error type, not just `throws`

### Integration Tests

Run the full clock-skew test matrix:
```bash
pnpm test packages/stellar-payments/src/clock-skew-verification.integration.test.ts
```

### Linting and Type Safety

```bash
pnpm lint
pnpm typecheck
```

---

## OpenAPI / API Contract

**No breaking changes** in this issue. All error responses use existing error structure:

```json
{
  "error": {
    "code": "STALE_TIMESTAMP",
    "message": "Timestamp is older than replay window (350.5s > 300s)",
    "details": {
      "errorType": "stale",
      "ageSeconds": 350.5,
      "windowSeconds": 300
    }
  }
}
```

Webhook endpoint definitions remain unchanged.

---

## Database Migrations

**No migrations required** in this issue. All timestamp validation is in-memory / cryptographic.

---

## Future Work

1. **Phase 2:** Add injectable clock to payment authorization expiry checks
2. **Phase 3:** Add time-based SLA monitoring to settlement reconciliation
3. **Phase 4:** Add explicit clock skew metrics (via observability integration)

---

## References

- **Issue:** #115 - Add clock-skew verification test matrix
- **Implementation:** `packages/stellar-payments/src/clock-skew-verification.integration.test.ts`
- **Clock Abstraction:** `packages/testkit/src/clock.ts`
- **Webhook Module:** `packages/shared/src/webhooks.ts`
