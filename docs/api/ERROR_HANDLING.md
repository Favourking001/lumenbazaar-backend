# Error Handling Guide

## Overview

This document explains how to handle errors from the LumenBazaar API. All errors follow a structured format with stable error codes, retry guidance, and safe user messages.

## Error Response Format

All error responses follow this format:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Detailed error message",
    "details": {
      "field": "additional context"
    }
  },
  "requestId": "req_12345..."
}
```

- **code**: Stable, unique error code (see [Error Catalog](./error-catalog.md))
- **message**: Detailed message for debugging
- **details**: Optional context (sensitive data is redacted)
- **requestId**: Unique request ID for support reference

## HTTP Status Codes

| Status | Meaning | Retry? |
|--------|---------|--------|
| 400 | Client error (validation, format, etc.) | No |
| 401 | Authentication failed or missing | No |
| 402 | Payment required | Yes |
| 403 | Forbidden (no permission) | No |
| 404 | Resource not found | No |
| 409 | Conflict (e.g., replay detected) | No |
| 424 | Failed Dependency (e.g., trustline required) | Yes |
| 429 | Rate limited | Yes (with backoff) |
| 500 | Internal server error | Yes (with backoff) |
| 502 | Bad Gateway (infrastructure issue) | Yes (with backoff) |

## Retry Strategy

### Error Categories

1. **Never Retry** (4xx errors, mostly)
   - Validation errors, authentication failures, resource not found, conflicts
   - Retrying will not help; fix the request or contact support

2. **Safe to Retry** (2xx-like or idempotent failures)
   - Certain errors that occur due to timing or concurrency
   - Safe to retry immediately or with a brief delay

3. **Backoff Required** (5xx errors, rate limits)
   - Infrastructure issues, rate limits, temporary failures
   - Use exponential backoff: 1s, 2s, 4s, 8s (with jitter)
   - Max 3 retries typical; respect `Retry-After` header

### Implementation Example

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof LumenError)) {
        throw error; // Not a Lumen error, re-throw
      }

      const catalogEntry = getCatalogEntry(error.code);
      if (!catalogEntry?.retryable) {
        throw error; // Don't retry non-retryable errors
      }

      if (
        catalogEntry.retryGuidance === "backoff_required" ||
        error.statusCode === 429
      ) {
        const delay = Math.pow(2, attempt) * 1000;
        const retryAfter =
          error.details?.["retry-after"] ||
          error.headers?.["retry-after"];
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : delay;

        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      attempt++;
      lastError = error;
    }
  }

  throw lastError;
}
```

## Safe User Messages

All error responses include a `safeUserMessage` field suitable for displaying to end users. These messages:

- Do not leak technical details, stack traces, or system information
- Do not reveal account IDs, payment hashes, or other sensitive identifiers
- Do not expose infrastructure details (hostnames, IP addresses, internal service names)
- Provide actionable guidance when possible

Never display the raw error message or details to end users; always use the safe message.

## Common Error Scenarios

### Payment Required (402)

```json
{
  "ok": false,
  "error": {
    "code": "PAYMENT_REQUIRED",
    "message": "Resource requires payment. See requirements in body.",
    "details": {
      "amount": "1000000",
      "asset": "USDC",
      "network": "stellar:testnet"
    }
  }
}
```

**Action**: Construct and sign a Stellar payment transaction matching the requirements. See [x402 Specification](https://x402.dev).

### Rate Limited (429)

```json
{
  "ok": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded"
  }
}
```

**Headers**:
- `Retry-After`: Seconds to wait before retrying
- `x-ratelimit-reset`: ISO 8601 timestamp of reset
- `x-ratelimit-remaining`: Requests left in window

**Action**: Wait for the `Retry-After` interval, then retry with exponential backoff.

### Validation Failed (400)

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "details": {
      "field": "paymentPayload",
      "issue": "required field missing"
    }
  }
}
```

**Action**: Fix the validation issue and resubmit. Check the details for the specific field.

### Internal Error (500)

```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error"
  },
  "requestId": "req_abc123..."
}
```

**Action**: Retry with exponential backoff. If the error persists, contact support with the `requestId`.

## Using the Error Catalog

The error catalog is available in machine-readable format and includes:

- **code**: Unique error identifier
- **httpStatus**: HTTP status code
- **category**: Error category (validation, authentication, resource, payment, infrastructure)
- **retryable**: Whether retrying is safe
- **retryGuidance**: Retry strategy (safe_to_retry, backoff_required, never_retry)
- **maxRetries**: Maximum suggested retry attempts
- **reconciliation**: For payment errors, how to verify or recover state
- **safeUserMessage**: Safe message for end users
- **documentation**: Detailed explanation

See [error-catalog.json](./error-catalog.json) for the complete structured catalog.

## Adding New Errors

When adding a new error code:

1. Add the code to `packages/shared/src/errors.ts`
2. Add a catalog entry in `packages/shared/src/errorCatalog.ts` with all required fields
3. Run `pnpm check` to validate and regenerate the catalog
4. Update this guide if the error category introduces new recovery patterns

## Support

For help with errors:

1. Check the [Error Catalog](./error-catalog.md) for the code
2. Review reconciliation guidance or safe messages
3. If retryable, implement appropriate retry logic
4. Contact support with the error code and `requestId` if the issue persists

## Security

- Error responses are sanitized; no secrets, credentials, or stack traces are leaked
- Sensitive details are redacted with `[redacted]`
- Error codes and messages are stable and safe to log
- Detailed error information is available through support channels when needed
