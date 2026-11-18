# Issue #115 Clock-Skew Verification Test Matrix - Audit Report

## Step 1: Time-Based Decision Audit

### Summary
Identified 5 critical time-based decisions across the codebase:

### 1. Webhook Signature Verification (CRITICAL - Replay Window)
**File**: `packages/shared/src/webhooks.ts`
- **Line 174**: `verifyWebhookSignature()` - Timestamp validation with replay window
  - Reads: `new Date()` for current time (NOT INJECTABLE)
  - Compares: `receivedTime.getTime()` vs `nowTime.getTime()` (age calculation)
  - Decision: Accept if `0 <= ageSeconds <= replayWindowSeconds` (default 300s)
  - Default window: 5 minutes (300 seconds)
  - **Error type**: Currently no distinction between stale/future/indeterminate
  - **Time injectable**: NO - uses system Date.now() via new Date()
  - **Tolerance**: ±300 seconds

### 2. Receipt Evidence Verification (NON-CRITICAL - Deterministic)
**File**: `packages/stellar-payments/src/receiptVerification.ts`
- **Line 174-200**: `verifyReceiptEvidence()` - Timestamp field comparison (ISO 8601)
  - Only compares stored values (not time-dependent logic)
  - Uses `receipt.status` enum comparison, not actual time
  - **Time injectable**: NO - purely deterministic field matching
  - **Concern**: False positive in audit (not time-based decision)

### 3. Settlement Finality Polling (TIME-DEPENDENT - Retry Logic)
**File**: `packages/stellar-payments/src/x402Adapter.ts`
- **Line 358-420**: `resolveRpcFinality()` - Polling with exponential backoff
  - Uses `setTimeout(delay)` - NOT injectable
  - Retry count: 20 attempts (max ~30 seconds via exponential backoff)
  - Base delay: 100ms, max: 2000ms
  - **Decision**: Continue polling until success, failure, or timeout
  - **Error type**: Returns `{status: "pending" | "confirmed" | "failed"}`
  - **Time injectable**: NO - hardcoded setTimeout
  - **Concern**: This is not time-skew sensitive (relative delays, not absolute time)

### 4. X402 Payment Expiration Check (POTENTIAL - In Upstream @x402/stellar)
**File**: `packages/stellar-payments/src/x402Adapter.ts`
- **Integration point**: ExactStellarScheme.verify() from @x402/core
  - Calls upstream verifier (not visible in this codebase)
  - @x402/core may validate transaction timeout ledger (not timestamp)
  - **Assumption**: Likely uses ledger-based expiry (not absolute time)
  - **Recommendation**: Verify with @x402/core team

### 5. Webhook Payload Timestamp Assignment (INFORMATIONAL)
**File**: `packages/shared/src/webhooks.ts`
- **Line 81**: `buildWebhookPayload(..., timestamp: string)` - Accepts timestamp as parameter
  - Timestamp is passed in, not generated internally (injectable at call site)
  - **Decision**: None (just stored as string)
  - **Time injectable**: YES - but injected at caller level

---

## Findings

### Critical Time-Based Decisions Requiring Clock Injection
1. **Webhook Signature Verification Replay Window** (PRIMARY TARGET)
   - Current implementation: Uses `new Date()` directly
   - Must be made injectable for clock-skew testing
   - Requires error distinction (stale vs future vs indeterminate)

### Secondary Findings
2. Settlement finality polling is retry-count based, not time-skew sensitive
3. Receipt verification is deterministic field matching
4. Payment expiration likely handled in upstream @x402/stellar library

### Implementation Gaps
- No clock abstraction layer currently exists
- No error type distinction for time validation failures
- Webhook timestamp verification has no testable clock injection point

---

## Next Steps (Steps 2-4)

### Step 2: Add Clock Injection
- Create minimal `Clock` interface in `packages/testkit/src/`
- Modify `verifyWebhookSignature()` to accept optional `clock` parameter
- Default to real Date.now()

### Step 3: Error Distinction
- Add error codes: `"WEBHOOK_SIGNATURE_STALE"`, `"WEBHOOK_SIGNATURE_FUTURE"`, `"WEBHOOK_SIGNATURE_INDETERMINATE"`
- Distinguish based on time delta vs window

### Step 4: Test Matrix
- 5-minute replay window (300 seconds)
- Test cases: zero skew, boundary ±1s, ±300s, ±301s, invalid timestamps

