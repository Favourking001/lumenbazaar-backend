/**
 * Structured error catalog for SDK and API consumers.
 * Single source of truth for error codes, retryability, recovery guidance, and safe messages.
 * Generated from typed errors and OpenAPI definitions via build scripts.
 */

import { type ErrorCode } from "./errors.js";

export type RetryGuidance = "safe_to_retry" | "backoff_required" | "never_retry";

export type ErrorCatalogEntry = {
  /** Unique, stable error code. Never changes once released. */
  code: ErrorCode;

  /** HTTP status code returned when this error occurs. */
  httpStatus: number;

  /** Category for grouping errors (e.g., "validation", "authentication", "resource", "payment", "infrastructure"). */
  category: string;

  /** Whether the operation can be safely retried. */
  retryable: boolean;

  /**
   * Guidance for retry behavior:
   * - "safe_to_retry": Safe to retry immediately or with brief delay
   * - "backoff_required": Must use exponential backoff (e.g., 1s, 2s, 4s, 8s)
   * - "never_retry": Do not retry; state is terminal or retrying would worsen the condition
   */
  retryGuidance: RetryGuidance;

  /**
   * Maximum safe retry count. Omitted if never_retry.
   * Defaults to 3 if retryable and not specified.
   */
  maxRetries?: number;

  /**
   * Reconciliation guidance specific to payment-related errors.
   * What should the consumer check or do to recover or understand the state.
   */
  reconciliation?: string;

  /**
   * Safe user-facing message. Must not leak:
   * - Internal implementation details, stack traces, or error codes from other systems
   * - Secrets, keys, tokens, or credentials
   * - Account IDs, payment IDs, transaction hashes, or other sensitive identifiers
   * - Information that could aid an attacker (e.g., "database is offline", revealing infrastructure)
   */
  safeUserMessage: string;

  /** Detailed documentation for developers and SDK consumers. */
  documentation: string;

  /** Whether this error is publicly documented and safe to expose to SDK/API consumers. */
  isPublic: boolean;
};

/**
 * Catalog entries indexed by error code.
 * Must include every error code from packages/shared/src/errors.ts
 */
export const errorCatalog: Record<ErrorCode, ErrorCatalogEntry> = {
  PAYMENT_REQUIRED: {
    code: "PAYMENT_REQUIRED",
    httpStatus: 402,
    category: "payment",
    retryable: true,
    retryGuidance: "safe_to_retry",
    maxRetries: 3,
    reconciliation:
      "Payment is required to access this resource. Check the payment requirements in the response; verify the payer wallet has sufficient balance and trustlines for the required asset on the specified network. Resubmit the signed payment transaction.",
    safeUserMessage:
      "Payment required to access this resource. Please submit the required payment and try again.",
    documentation:
      "The resource requires payment before access is granted. Consumers must provide a signed Stellar payment transaction matching the specified requirements (amount, asset, network, recipient). See x402 specification for payment flow details.",
    isPublic: true
  },

  UNSUPPORTED_NETWORK: {
    code: "UNSUPPORTED_NETWORK",
    httpStatus: 400,
    category: "validation",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The requested network (e.g., stellar:testnet, stellar:pubnet) is not supported by this resource. Verify the supported networks in the resource definition and request the resource on a supported network.",
    safeUserMessage: "This resource is not available on the requested network.",
    documentation:
      "The requested network is not supported by this service or resource. Consumers must select a supported network from the service's network list. Common supported networks: stellar:testnet, stellar:pubnet.",
    isPublic: true
  },

  UNSUPPORTED_ASSET: {
    code: "UNSUPPORTED_ASSET",
    httpStatus: 400,
    category: "validation",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The requested asset (code or contract ID) is not supported by this resource. Check the resource definition for supported assets and resubmit the request with a supported asset.",
    safeUserMessage: "This resource does not support the requested asset.",
    documentation:
      "The requested asset is not supported by this resource or service. Each resource specifies a fixed, supported asset for payments. Consumers must use an asset listed in the resource specification.",
    isPublic: true
  },

  INVALID_PAYMENT_PAYLOAD: {
    code: "INVALID_PAYMENT_PAYLOAD",
    httpStatus: 400,
    category: "validation",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The payment payload structure is malformed or missing required fields. Verify the payload against the x402 specification: check x402Version, paymentPayload structure, paymentRequirements format, and base64 encoding of transaction XDR. Re-encode and resubmit.",
    safeUserMessage: "The payment request format is invalid. Please check your request and try again.",
    documentation:
      "The payment payload does not conform to the x402 specification. Payloads must be properly formed JSON with all required fields, valid base64 transaction XDR, and correct x402Version. Refer to the x402 v2 specification for payload structure.",
    isPublic: true
  },

  INVALID_SIGNATURE: {
    code: "INVALID_SIGNATURE",
    httpStatus: 401,
    category: "authentication",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The transaction signature is invalid or the transaction was not signed by the expected payer. Verify the payer's public key matches the transaction signer, re-sign the transaction with the correct keypair, and resubmit. Ensure no modifications were made to the transaction after signing.",
    safeUserMessage: "Payment signature is invalid. Please sign the payment request and try again.",
    documentation:
      "The transaction signature does not match the transaction content or the expected signer. Signatures must be created by the payer's Stellar keypair over the canonical transaction envelope XDR. Ensure signatures use the correct signing algorithm and that transaction content has not been modified.",
    isPublic: true
  },

  AUTH_EXPIRED: {
    code: "AUTH_EXPIRED",
    httpStatus: 400,
    category: "authentication",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The authentication token, seller API key, or stream access grant has expired. Obtain a new credential: refresh the token, issue a new API key, or create a new stream access grant with a current expiry time.",
    safeUserMessage: "Your authentication has expired. Please re-authenticate and try again.",
    documentation:
      "A time-limited authentication credential (token, API key, or grant) has expired past the server clock. Consumers must obtain fresh credentials within their validity window.",
    isPublic: true
  },

  REPLAY_DETECTED: {
    code: "REPLAY_DETECTED",
    httpStatus: 409,
    category: "payment",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The payment has already been processed (unique constraint on paymentHash detected). Verify whether the original transaction completed successfully by checking settlement receipts. If lost, request a new payment with a different nonce or user interaction. Never reuse the same transaction.",
    safeUserMessage:
      "This payment has already been processed. Check your transaction history for confirmation, or submit a new payment.",
    documentation:
      "The payment hash matches a previously processed payment, indicating a replay attempt. Payments are protected by unique hashing to prevent duplicate charges. Submit a new payment with fresh transaction data and current nonce.",
    isPublic: true
  },

  AMOUNT_MISMATCH: {
    code: "AMOUNT_MISMATCH",
    httpStatus: 400,
    category: "validation",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The transaction amount does not match the required payment amount. Verify the required amount in the payment requirements, ensure the transaction sends the exact amount in the smallest atomic units, and resubmit.",
    safeUserMessage: "The payment amount does not match the required amount. Please try again with the correct amount.",
    documentation:
      "The transaction amount differs from the requirement. Payments use atomic units; 1 unit is the smallest divisible amount. The transaction must send the exact required amount with no rounding.",
    isPublic: true
  },

  ASSET_MISMATCH: {
    code: "ASSET_MISMATCH",
    httpStatus: 400,
    category: "validation",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The transaction asset (code or contract ID) does not match the required asset. Check the payment requirements for the exact asset specification and resubmit with the correct asset.",
    safeUserMessage: "The payment asset does not match the required asset. Please try again with the correct asset.",
    documentation:
      "The asset in the transaction differs from the requirement. Verify the exact asset code and issuer (or contract ID for soroban assets) from the payment requirements and resubmit.",
    isPublic: true
  },

  RECIPIENT_MISMATCH: {
    code: "RECIPIENT_MISMATCH",
    httpStatus: 400,
    category: "validation",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The transaction recipient (payTo address) does not match the requirement. Verify the required payTo address in the payment requirements and resubmit to the correct recipient.",
    safeUserMessage: "The payment recipient does not match the required recipient.",
    documentation:
      "The recipient address in the transaction does not match the requirement. Verify the exact payTo address from the payment requirements and ensure no typos or modifications.",
    isPublic: true
  },

  SETTLEMENT_FAILED: {
    code: "SETTLEMENT_FAILED",
    httpStatus: 502,
    category: "infrastructure",
    retryable: true,
    retryGuidance: "backoff_required",
    maxRetries: 3,
    reconciliation:
      "Settlement could not complete due to a temporary infrastructure issue (e.g., Horizon unavailable, rate limited, or network lag). Wait a few seconds, then retry. If the issue persists, check the backend status page or contact support.",
    safeUserMessage: "Payment settlement is temporarily unavailable. Please try again in a few moments.",
    documentation:
      "Settlement submission to Stellar failed due to a temporary backend infrastructure issue. This typically indicates Horizon/RPC transience. Retry with exponential backoff. If retries are exhausted, check system status or support channels.",
    isPublic: true
  },

  TRUSTLINE_REQUIRED: {
    code: "TRUSTLINE_REQUIRED",
    httpStatus: 424,
    category: "payment",
    retryable: true,
    retryGuidance: "backoff_required",
    maxRetries: 1,
    reconciliation:
      "The recipient account does not have a trustline for the payment asset. The recipient must establish a trustline (on the Stellar network) before payment can be received. After the trustline is created, retry the payment. This requires one blockchain transaction from the recipient.",
    safeUserMessage:
      "The payment cannot be delivered because the recipient has not configured support for this asset. Please contact the recipient to enable the asset.",
    documentation:
      "On Stellar, accounts must establish explicit trustlines for custom assets before receiving payments. The recipient must execute a trust transaction for the asset. After the trustline is confirmed on-chain, resubmit the payment.",
    isPublic: true
  },

  RESOURCE_NOT_FOUND: {
    code: "RESOURCE_NOT_FOUND",
    httpStatus: 404,
    category: "resource",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The requested resource does not exist or has been deleted. Verify the resource ID and check if it is still available. Browse the resource catalog to find an available alternative.",
    safeUserMessage: "The requested resource was not found. Please verify the resource ID.",
    documentation:
      "The resource ID does not match any existing resource. The resource may have been deleted or never existed. Use the list resources endpoint to discover available resources.",
    isPublic: true
  },

  SELLER_NOT_FOUND: {
    code: "SELLER_NOT_FOUND",
    httpStatus: 404,
    category: "resource",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The referenced seller does not exist. Verify the seller ID and check if the seller profile is still active. Use the sellers API to discover available sellers.",
    safeUserMessage: "The requested seller was not found.",
    documentation:
      "The seller ID does not match any existing seller profile. The seller may have been deactivated or the ID is incorrect. Use the list sellers endpoint to find available sellers.",
    isPublic: true
  },

  SELLER_DOMAIN_UNVERIFIED: {
    code: "SELLER_DOMAIN_UNVERIFIED",
    httpStatus: 403,
    category: "authentication",
    retryable: true,
    retryGuidance: "backoff_required",
    maxRetries: 3,
    reconciliation:
      "The seller's domain claim has not been verified. The seller must complete domain verification by publishing the verification record on their domain. After verification is confirmed, retry the request. Typical delay is a few minutes after the seller completes verification.",
    safeUserMessage: "The seller's domain has not been verified. Please try again later.",
    documentation:
      "The seller has claimed a domain but verification is not yet complete. Domain verification confirms the seller controls the domain. After the seller publishes the verification record and it propagates, resubmit the request.",
    isPublic: true
  },

  CATALOG_VALIDATION_FAILED: {
    code: "CATALOG_VALIDATION_FAILED",
    httpStatus: 400,
    category: "validation",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The catalog metadata (discovery, resource, or asset definition) does not conform to the schema. Check the validation error details for the specific field that failed, correct the metadata, and resubmit.",
    safeUserMessage: "The catalog metadata is invalid. Please check your submission and try again.",
    documentation:
      "Catalog metadata validation failed against the expected schema. Details in the error response indicate which fields are invalid. Correct the metadata and resubmit.",
    isPublic: true
  },

  ROUTE_TEMPLATE_INVALID: {
    code: "ROUTE_TEMPLATE_INVALID",
    httpStatus: 400,
    category: "validation",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "The resource route template does not conform to valid template syntax. Verify the template format against the documentation and correct any syntax errors before resubmitting.",
    safeUserMessage: "The resource route template is invalid.",
    documentation:
      "The route template does not follow valid syntax. Route templates use parameter placeholders like {param}. Ensure all placeholders are properly formatted and the template is a valid URI pattern.",
    isPublic: true
  },

  VALIDATION_FAILED: {
    code: "VALIDATION_FAILED",
    httpStatus: 400,
    category: "validation",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "Request validation failed due to schema mismatch, invalid data types, or missing required fields. Check the error details for the specific field, correct the input, and resubmit.",
    safeUserMessage: "Your request is invalid. Please check the required fields and try again.",
    documentation:
      "Generic validation error indicating the request does not conform to the API schema. See details in the error response for the specific validation failure.",
    isPublic: true
  },

  RATE_LIMITED: {
    code: "RATE_LIMITED",
    httpStatus: 429,
    category: "infrastructure",
    retryable: true,
    retryGuidance: "backoff_required",
    maxRetries: 3,
    reconciliation:
      "Rate limit exceeded. Backoff immediately. Response headers specify the retry window (Retry-After, x-ratelimit-reset). Wait until the window resets before retrying. Implement exponential backoff to avoid repeated rate limit errors.",
    safeUserMessage:
      "Too many requests. Please wait before trying again. See the response headers for the reset time.",
    documentation:
      "API rate limit has been exceeded. Response includes retry-after information. Clients must implement exponential backoff and respect rate limit headers to avoid service disruption.",
    isPublic: true
  },

  UNAUTHORIZED: {
    code: "UNAUTHORIZED",
    httpStatus: 401,
    category: "authentication",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "Authentication failed or is missing. Verify the authentication method (API key, token, or signature) is correct and present. For seller API keys, check the key prefix, expiry, and revocation status. Re-authenticate and retry.",
    safeUserMessage: "Authentication failed. Please provide valid credentials and try again.",
    documentation:
      "Request did not include valid authentication credentials or the credentials are invalid. Verify the auth method (Bearer token, API key header, or signature) and resubmit with valid credentials.",
    isPublic: true
  },

  FORBIDDEN: {
    code: "FORBIDDEN",
    httpStatus: 403,
    category: "authentication",
    retryable: false,
    retryGuidance: "never_retry",
    reconciliation:
      "Authentication succeeded but the credential does not have permission for this action. Use a credential with the required scope or permission level. If using an API key, check its scopes match the action (e.g., resources:write for updates).",
    safeUserMessage: "You do not have permission to perform this action.",
    documentation:
      "The request is authenticated but does not have required authorization. Verify the credential has the necessary scopes or permission level for the requested action.",
    isPublic: true
  },

  INTERNAL_ERROR: {
    code: "INTERNAL_ERROR",
    httpStatus: 500,
    category: "infrastructure",
    retryable: true,
    retryGuidance: "backoff_required",
    maxRetries: 3,
    reconciliation:
      "An unexpected server error occurred. This is not a client error. Retry after a short delay. If the error persists across multiple requests or affects multiple consumers, check the backend status page or contact support with the request ID.",
    safeUserMessage: "An unexpected error occurred. Please try again later.",
    documentation:
      "An internal server error occurred that is not related to the request content. Consumers should retry with exponential backoff. If errors persist, check status page or contact support.",
    isPublic: true
  }
};

/**
 * Catalog metadata.
 * Version is incremented for breaking changes; patch/minor changes are backward compatible.
 */
export const catalogMetadata = {
  /** Semantic version of the error catalog. Consumers can pin to a specific version. */
  version: "1.0.0",

  /** ISO 8601 timestamp of the last catalog generation. For reference only; not used for versioning. */
  generatedAt: new Date().toISOString(),

  /** Number of error codes in the catalog. */
  entryCount: Object.keys(errorCatalog).length,

  /** Whether all entries are public (no internal-only errors). */
  allEntriesPublic: Object.values(errorCatalog).every((e) => e.isPublic)
};

/**
 * Validate catalog completeness and integrity.
 * Returns errors if the catalog is invalid or incomplete.
 */
export function validateErrorCatalog(): string[] {
  const errors: string[] = [];

  // Check for required fields
  for (const [code, entry] of Object.entries(errorCatalog)) {
    if (!entry.code) {
      errors.push(`${code}: missing code`);
    }
    if (entry.httpStatus === undefined) {
      errors.push(`${code}: missing httpStatus`);
    }
    if (!entry.category) {
      errors.push(`${code}: missing category`);
    }
    if (entry.retryable === undefined) {
      errors.push(`${code}: missing retryable`);
    }
    if (!entry.retryGuidance) {
      errors.push(`${code}: missing retryGuidance`);
    }
    if (!entry.safeUserMessage) {
      errors.push(`${code}: missing safeUserMessage`);
    }
    if (!entry.documentation) {
      errors.push(`${code}: missing documentation`);
    }
    if (entry.isPublic === undefined) {
      errors.push(`${code}: missing isPublic`);
    }

    // Validate retry guidance is consistent with retryable flag
    if (!entry.retryable && entry.retryGuidance !== "never_retry") {
      errors.push(`${code}: retryable=false but retryGuidance is not "never_retry"`);
    }

    // Validate maxRetries is only present when retryable
    if (!entry.retryable && entry.maxRetries !== undefined) {
      errors.push(`${code}: maxRetries specified but retryable=false`);
    }

    // Validate safe message doesn't contain suspicious patterns
    const suspiciousPatterns = [
      /\[redacted\]/i,
      /stack\s*trace/i,
      /at\s+\w+\s*\(/,
      /error\s*code\s*[:=]/i,
      /(secret|seed|private|token|key|password|auth)/i,
      /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
      /localhost|127\.0\.0\.1|0\.0\.0\.0/i
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(entry.safeUserMessage)) {
        errors.push(
          `${code}: safeUserMessage may contain sensitive or implementation detail: ${pattern.source}`
        );
      }
    }

    // Validate reconciliation guidance for payment errors
    if (entry.category === "payment" && !entry.reconciliation) {
      errors.push(`${code}: payment error missing reconciliation guidance`);
    }
  }

  // Check for duplicate codes
  const codes = Object.values(errorCatalog).map((e) => e.code);
  const uniqueCodes = new Set(codes);
  if (codes.length !== uniqueCodes.size) {
    errors.push("Duplicate error codes found in catalog");
  }

  return errors;
}

/**
 * Get a safe error object for API responses.
 * Ensures no sensitive data is leaked.
 */
export function getCatalogEntry(code: ErrorCode | string): ErrorCatalogEntry | null {
  if (code in errorCatalog) {
    return errorCatalog[code as ErrorCode];
  }
  return null;
}

/**
 * Get all public error catalog entries.
 */
export function getPublicErrorCatalog(): Record<ErrorCode, ErrorCatalogEntry> {
  return Object.fromEntries(
    Object.entries(errorCatalog).filter(([, entry]) => entry.isPublic)
  ) as Record<ErrorCode, ErrorCatalogEntry>;
}
