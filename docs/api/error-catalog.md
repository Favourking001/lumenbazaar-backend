# Error Catalog

Structured error definitions for SDK and API consumers. This is the single source of truth for error codes, retryability, recovery guidance, and safe user messages.

## Catalog Info

- **Version**: 1.0.0
- **Total Errors**: 22
- **All Public**: Yes

## Error Categories

- **authentication**
- **infrastructure**
- **payment**
- **resource**
- **validation**

## Retry Strategy

| Guidance | Meaning |
|----------|---------|
| `safe_to_retry` | Safe to retry immediately or with brief delay |
| `backoff_required` | Use exponential backoff (e.g., 1s, 2s, 4s, 8s) |
| `never_retry` | Terminal state; do not retry |

## Error Codes

### AMOUNT_MISMATCH

**HTTP Status**: `400`

**Category**: `validation`

**Retryable**: No

**Safe User Message**:
> The payment amount does not match the required amount. Please try again with the correct amount.

**Description**:
The transaction amount differs from the requirement. Payments use atomic units; 1 unit is the smallest divisible amount. The transaction must send the exact required amount with no rounding.

---

### ASSET_MISMATCH

**HTTP Status**: `400`

**Category**: `validation`

**Retryable**: No

**Safe User Message**:
> The payment asset does not match the required asset. Please try again with the correct asset.

**Description**:
The asset in the transaction differs from the requirement. Verify the exact asset code and issuer (or contract ID for soroban assets) from the payment requirements and resubmit.

---

### AUTH_EXPIRED

**HTTP Status**: `400`

**Category**: `authentication`

**Retryable**: No

**Safe User Message**:
> Your authentication has expired. Please re-authenticate and try again.

**Description**:
A time-limited authentication credential (token, API key, or grant) has expired past the server clock. Consumers must obtain fresh credentials within their validity window.

---

### CATALOG_VALIDATION_FAILED

**HTTP Status**: `400`

**Category**: `validation`

**Retryable**: No

**Safe User Message**:
> The catalog metadata is invalid. Please check your submission and try again.

**Description**:
Catalog metadata validation failed against the expected schema. Details in the error response indicate which fields are invalid. Correct the metadata and resubmit.

---

### FORBIDDEN

**HTTP Status**: `403`

**Category**: `authentication`

**Retryable**: No

**Safe User Message**:
> You do not have permission to perform this action.

**Description**:
The request is authenticated but does not have required authorization. Verify the credential has the necessary scopes or permission level for the requested action.

---

### INTERNAL_ERROR

**HTTP Status**: `500`

**Category**: `infrastructure`

**Retryable**: Yes — backoff_required (max 3 retries)

**Safe User Message**:
> An unexpected error occurred. Please try again later.

**Description**:
An internal server error occurred that is not related to the request content. Consumers should retry with exponential backoff. If errors persist, check status page or contact support.

**Recovery Guidance**:
An unexpected server error occurred. This is not a client error. Retry after a short delay. If the error persists across multiple requests or affects multiple consumers, check the backend status page or contact support with the request ID.

---

### INVALID_PAYMENT_PAYLOAD

**HTTP Status**: `400`

**Category**: `validation`

**Retryable**: No

**Safe User Message**:
> The payment request format is invalid. Please check your request and try again.

**Description**:
The payment payload does not conform to the x402 specification. Payloads must be properly formed JSON with all required fields, valid base64 transaction XDR, and correct x402Version. Refer to the x402 v2 specification for payload structure.

---

### INVALID_SIGNATURE

**HTTP Status**: `401`

**Category**: `authentication`

**Retryable**: No

**Safe User Message**:
> Payment signature is invalid. Please sign the payment request and try again.

**Description**:
The transaction signature does not match the transaction content or the expected signer. Signatures must be created by the payer's Stellar keypair over the canonical transaction envelope XDR. Ensure signatures use the correct signing algorithm and that transaction content has not been modified.

---

### PAYMENT_REQUIRED

**HTTP Status**: `402`

**Category**: `payment`

**Retryable**: Yes — safe_to_retry (max 3 retries)

**Safe User Message**:
> Payment required to access this resource. Please submit the required payment and try again.

**Description**:
The resource requires payment before access is granted. Consumers must provide a signed Stellar payment transaction matching the specified requirements (amount, asset, network, recipient). See x402 specification for payment flow details.

**Recovery Guidance**:
Payment is required to access this resource. Check the payment requirements in the response; verify the payer wallet has sufficient balance and trustlines for the required asset on the specified network. Resubmit the signed payment transaction.

---

### RATE_LIMITED

**HTTP Status**: `429`

**Category**: `infrastructure`

**Retryable**: Yes — backoff_required (max 3 retries)

**Safe User Message**:
> Too many requests. Please wait before trying again. See the response headers for the reset time.

**Description**:
API rate limit has been exceeded. Response includes retry-after information. Clients must implement exponential backoff and respect rate limit headers to avoid service disruption.

---

### RECIPIENT_MISMATCH

**HTTP Status**: `400`

**Category**: `validation`

**Retryable**: No

**Safe User Message**:
> The payment recipient does not match the required recipient.

**Description**:
The recipient address in the transaction does not match the requirement. Verify the exact payTo address from the payment requirements and ensure no typos or modifications.

---

### REPLAY_DETECTED

**HTTP Status**: `409`

**Category**: `payment`

**Retryable**: No

**Safe User Message**:
> This payment has already been processed. Check your transaction history for confirmation, or submit a new payment.

**Description**:
The payment hash matches a previously processed payment, indicating a replay attempt. Payments are protected by unique hashing to prevent duplicate charges. Submit a new payment with fresh transaction data and current nonce.

**Recovery Guidance**:
The payment has already been processed (unique constraint on paymentHash detected). Verify whether the original transaction completed successfully by checking settlement receipts. If lost, request a new payment with a different nonce or user interaction. Never reuse the same transaction.

---

### RESOURCE_NOT_FOUND

**HTTP Status**: `404`

**Category**: `resource`

**Retryable**: No

**Safe User Message**:
> The requested resource was not found. Please verify the resource ID.

**Description**:
The resource ID does not match any existing resource. The resource may have been deleted or never existed. Use the list resources endpoint to discover available resources.

---

### ROUTE_TEMPLATE_INVALID

**HTTP Status**: `400`

**Category**: `validation`

**Retryable**: No

**Safe User Message**:
> The resource route template is invalid.

**Description**:
The route template does not follow valid syntax. Route templates use parameter placeholders like {param}. Ensure all placeholders are properly formatted and the template is a valid URI pattern.

---

### SELLER_DOMAIN_UNVERIFIED

**HTTP Status**: `403`

**Category**: `authentication`

**Retryable**: Yes — backoff_required (max 3 retries)

**Safe User Message**:
> The seller's domain has not been verified. Please try again later.

**Description**:
The seller has claimed a domain but verification is not yet complete. Domain verification confirms the seller controls the domain. After the seller publishes the verification record and it propagates, resubmit the request.

**Recovery Guidance**:
The seller's domain claim has not been verified. The seller must complete domain verification by publishing the verification record on their domain. After verification is confirmed, retry the request. Typical delay is a few minutes after the seller completes verification.

---

### SELLER_NOT_FOUND

**HTTP Status**: `404`

**Category**: `resource`

**Retryable**: No

**Safe User Message**:
> The requested seller was not found.

**Description**:
The seller ID does not match any existing seller profile. The seller may have been deactivated or the ID is incorrect. Use the list sellers endpoint to find available sellers.

---

### SETTLEMENT_FAILED

**HTTP Status**: `502`

**Category**: `infrastructure`

**Retryable**: Yes — backoff_required (max 3 retries)

**Safe User Message**:
> Payment settlement is temporarily unavailable. Please try again in a few moments.

**Description**:
Settlement submission to Stellar failed due to a temporary backend infrastructure issue. This typically indicates Horizon/RPC transience. Retry with exponential backoff. If retries are exhausted, check system status or support channels.

**Recovery Guidance**:
Settlement could not complete due to a temporary infrastructure issue (e.g., Horizon unavailable, rate limited, or network lag). Wait a few seconds, then retry. If the issue persists, check the backend status page or contact support.

---

### TRUSTLINE_REQUIRED

**HTTP Status**: `424`

**Category**: `payment`

**Retryable**: Yes — backoff_required (max 1 retries)

**Safe User Message**:
> The payment cannot be delivered because the recipient has not configured support for this asset. Please contact the recipient to enable the asset.

**Description**:
On Stellar, accounts must establish explicit trustlines for custom assets before receiving payments. The recipient must execute a trust transaction for the asset. After the trustline is confirmed on-chain, resubmit the payment.

**Recovery Guidance**:
The recipient account does not have a trustline for the payment asset. The recipient must establish a trustline (on the Stellar network) before payment can be received. After the trustline is created, retry the payment. This requires one blockchain transaction from the recipient.

---

### UNAUTHORIZED

**HTTP Status**: `401`

**Category**: `authentication`

**Retryable**: No

**Safe User Message**:
> Authentication failed. Please provide valid credentials and try again.

**Description**:
Request did not include valid authentication credentials or the credentials are invalid. Verify the auth method (Bearer token, API key header, or signature) and resubmit with valid credentials.

---

### UNSUPPORTED_ASSET

**HTTP Status**: `400`

**Category**: `validation`

**Retryable**: No

**Safe User Message**:
> This resource does not support the requested asset.

**Description**:
The requested asset is not supported by this resource or service. Each resource specifies a fixed, supported asset for payments. Consumers must use an asset listed in the resource specification.

---

### UNSUPPORTED_NETWORK

**HTTP Status**: `400`

**Category**: `validation`

**Retryable**: No

**Safe User Message**:
> This resource is not available on the requested network.

**Description**:
The requested network is not supported by this service or resource. Consumers must select a supported network from the service's network list. Common supported networks: stellar:testnet, stellar:pubnet.

---

### VALIDATION_FAILED

**HTTP Status**: `400`

**Category**: `validation`

**Retryable**: No

**Safe User Message**:
> Your request is invalid. Please check the required fields and try again.

**Description**:
Generic validation error indicating the request does not conform to the API schema. See details in the error response for the specific validation failure.

---

## Adding New Errors

1. Add the error code to `packages/shared/src/errors.ts`
2. Add an entry to `packages/shared/src/errorCatalog.ts` with all required fields:
   - `code`: Stable, never changes
   - `httpStatus`: Appropriate HTTP status code
   - `category`: One of: validation, authentication, resource, payment, infrastructure
   - `retryable`: Boolean reflecting whether the operation can be safely retried
   - `retryGuidance`: safe_to_retry, backoff_required, or never_retry
   - `safeUserMessage`: Must not leak secrets, internal details, or identifiers
   - `documentation`: Developer-facing detailed explanation
   - `reconciliation` (payment errors only): How to recover or verify state
3. Run `pnpm check` to regenerate and validate the catalog
4. Commit the updated catalog and documentation

## CI Guard

The `pnpm check` command includes validation that:
- All error codes are documented
- No error codes are missing required fields
- All codes are unique
- No undocumented additions are committed
