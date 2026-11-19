import { z } from "zod";

/**
 * Job payload schema versioning system.
 *
 * All job payloads are wrapped in a versioned envelope containing:
 * - schemaVersion: Semantic version of the payload structure
 * - schemaId: Unique identifier for the job type (e.g., "webhook-delivery", "settlement-confirmation")
 * - payload: The actual job data, validated against the corresponding schema
 *
 * Versioning rules:
 * 1. MAJOR bump: Breaking changes to payload structure (fields removed, type changes)
 * 2. MINOR bump: Non-breaking additions (new optional fields)
 * 3. PATCH bump: Internal changes (bug fixes, documentation)
 *
 * Migration strategy:
 * - Unknown MAJOR versions → route to quarantine queue for manual investigation
 * - Unknown MINOR versions → attempt processing with best-effort validation
 * - Handlers validate PATCH versions automatically
 */

// ============================================================================
// Version Constants
// ============================================================================

export const JOB_SCHEMA_VERSION = "1.0.0";

// Schema IDs for each job type
export const schemaIds = {
  settlementConfirmation: "settlement-confirmation",
  resourceIndexing: "resource-indexing",
  searchSync: "search-sync",
  networkHealth: "network-health",
  receiptFinalizer: "receipt-finalizer",
  stalePaymentCleanup: "stale-payment-cleanup",
  webhookDelivery: "webhook-delivery",
  outboxRelay: "outbox-relay",
  outboxCleanup: "outbox-cleanup"
} as const;

export type SchemaId = (typeof schemaIds)[keyof typeof schemaIds];

// ============================================================================
// Individual Job Schemas (v1.0.0)
// ============================================================================

/**
 * Settlement confirmation job - validates payment settlement status on-chain.
 * Queries the blockchain to confirm transaction status and update local state.
 */
export const settlementConfirmationSchemaV1 = z.object({
  correlationId: z.string().optional().describe("Optional trace correlation ID"),
  paymentAttemptId: z.string().describe("Foreign key to PaymentAttempt record"),
  settlementId: z.string().optional().describe("Foreign key to Settlement record (may be null initially)"),
  transactionHash: z.string().optional().describe("Stellar transaction hash if available"),
  network: z.string().describe("Network identifier (e.g., 'stellar:pubnet', 'stellar:testnet')")
});

export type SettlementConfirmationPayload = z.infer<typeof settlementConfirmationSchemaV1>;

/**
 * Resource indexing job - builds search documents and metadata indexes.
 * Triggered when a resource is created or updated.
 */
export const resourceIndexingSchemaV1 = z.object({
  resourceId: z.string().describe("Foreign key to Resource record"),
  versionId: z.string().describe("Version identifier for change tracking")
});

export type ResourceIndexingPayload = z.infer<typeof resourceIndexingSchemaV1>;

/**
 * Search sync job - manages search document synchronization and rebuilds.
 * Can rebuild entire index or mark stale documents for re-indexing.
 */
export const searchSyncSchemaV1 = z.object({
  action: z.enum(["rebuild", "mark_stale"]).describe("Action to perform"),
  resourceId: z.string().optional().describe("Optional resource ID for targeted sync"),
  network: z.string().optional().describe("Optional network filter")
});

export type SearchSyncPayload = z.infer<typeof searchSyncSchemaV1>;

/**
 * Network health job - checks RPC and Horizon service availability.
 * Records health metrics and detects network outages.
 */
export const networkHealthSchemaV1 = z.object({
  network: z
    .enum(["stellar:testnet", "stellar:pubnet"])
    .describe("Network to check health status for")
});

export type NetworkHealthPayload = z.infer<typeof networkHealthSchemaV1>;

/**
 * Receipt finalizer job - finalizes receipts based on settlement confirmation.
 * Marks receipts as complete when associated settlements are confirmed.
 */
export const receiptFinalizerSchemaV1 = z.object({
  action: z
    .enum(["finalize_pending", "finalize_by_settlement", "retry_failed"])
    .describe("Finalization action"),
  settlementId: z.string().optional().describe("Settlement ID for targeted finalization"),
  maxAge: z.number().optional().describe("Maximum age in milliseconds for retry")
});

export type ReceiptFinalizerPayload = z.infer<typeof receiptFinalizerSchemaV1>;

/**
 * Stale payment cleanup job - enforces retention policy on payment records.
 * Marks expired payments, archives settled payments, and maintains audit trail.
 */
export const stalePaymentCleanupSchemaV1 = z.object({
  action: z
    .enum(["cleanup_expired", "cleanup_failed", "archive"])
    .describe("Cleanup action"),
  maxAgeMs: z.number().optional().describe("How long to keep records in milliseconds"),
  policy: z.record(z.unknown()).optional().describe("Optional policy override")
});

export type StalePaymentCleanupPayload = z.infer<typeof stalePaymentCleanupSchemaV1>;

/**
 * Webhook delivery job - delivers webhook events to merchant endpoints.
 * Includes retry logic, signature generation, and delivery tracking.
 */
export const webhookDeliverySchemaV1 = z.object({
  eventId: z.string().describe("Unique event ID for idempotency"),
  endpointId: z.string().describe("Foreign key to WebhookEndpoint record"),
  sellerId: z.string().describe("Foreign key to Seller record"),
  url: z.string().url().describe("Endpoint URL to deliver webhook to"),
  payload: z.record(z.unknown()).describe("Webhook payload (WebhookPayload structure)"),
  secret: z.string().describe("Current secret for HMAC-SHA256 signing"),
  previousSecrets: z.array(z.string()).optional().describe("Previous secrets in rotation window"),
  attemptNumber: z.number().int().min(0).describe("Attempt number (0-indexed)")
});

export type WebhookDeliveryPayload = z.infer<typeof webhookDeliverySchemaV1>;

/**
 * Outbox relay job - processes outbox events in order.
 * No parameters - job is just a trigger to process the next batch.
 */
export const outboxRelaySchemaV1 = z.object({});

export type OutboxRelayPayload = z.infer<typeof outboxRelaySchemaV1>;

/**
 * Outbox cleanup job - removes old delivered outbox events.
 * Maintains audit trail while preventing table bloat.
 */
export const outboxCleanupSchemaV1 = z.object({
  retentionDays: z.number().int().min(1).optional().describe("Days to retain delivered events")
});

export type OutboxCleanupPayload = z.infer<typeof outboxCleanupSchemaV1>;

// ============================================================================
// Schema Registry
// ============================================================================

/**
 * Registry mapping schema IDs to their Zod schemas.
 * Used for payload validation during enqueue and dequeue.
 */
export const schemaRegistry = {
  [schemaIds.settlementConfirmation]: {
    v1: settlementConfirmationSchemaV1
  },
  [schemaIds.resourceIndexing]: {
    v1: resourceIndexingSchemaV1
  },
  [schemaIds.searchSync]: {
    v1: searchSyncSchemaV1
  },
  [schemaIds.networkHealth]: {
    v1: networkHealthSchemaV1
  },
  [schemaIds.receiptFinalizer]: {
    v1: receiptFinalizerSchemaV1
  },
  [schemaIds.stalePaymentCleanup]: {
    v1: stalePaymentCleanupSchemaV1
  },
  [schemaIds.webhookDelivery]: {
    v1: webhookDeliverySchemaV1
  },
  [schemaIds.outboxRelay]: {
    v1: outboxRelaySchemaV1
  },
  [schemaIds.outboxCleanup]: {
    v1: outboxCleanupSchemaV1
  }
} as const;

// ============================================================================
// Versioned Envelope
// ============================================================================

/**
 * Job payload envelope that wraps all job data with versioning information.
 * Every job in the queue contains this envelope.
 */
export const jobEnvelopeSchema = z.object({
  schemaVersion: z.string().describe("Semantic version of the payload schema"),
  schemaId: z.enum(Object.values(schemaIds) as [string, ...string[]]).describe("Unique identifier for job type"),
  payload: z.record(z.unknown()).describe("Job payload (validated against schemaId schema)"),
  traceparent: z.string().optional().describe("W3C Trace Context for distributed tracing")
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Mapping of schema IDs to their payload types.
 * Used for type-safe payload access after validation.
 */
export type PayloadBySchemaId = {
  [schemaIds.settlementConfirmation]: SettlementConfirmationPayload;
  [schemaIds.resourceIndexing]: ResourceIndexingPayload;
  [schemaIds.searchSync]: SearchSyncPayload;
  [schemaIds.networkHealth]: NetworkHealthPayload;
  [schemaIds.receiptFinalizer]: ReceiptFinalizerPayload;
  [schemaIds.stalePaymentCleanup]: StalePaymentCleanupPayload;
  [schemaIds.webhookDelivery]: WebhookDeliveryPayload;
  [schemaIds.outboxRelay]: OutboxRelayPayload;
  [schemaIds.outboxCleanup]: OutboxCleanupPayload;
};

/**
 * Union of all possible job payloads.
 */
export type AnyJobPayload =
  | SettlementConfirmationPayload
  | ResourceIndexingPayload
  | SearchSyncPayload
  | NetworkHealthPayload
  | ReceiptFinalizerPayload
  | StalePaymentCleanupPayload
  | WebhookDeliveryPayload
  | OutboxRelayPayload
  | OutboxCleanupPayload;

/**
 * Quarantine reason enumeration.
 * Describes why a payload was unable to be processed.
 */
export enum QuarantineReason {
  UNKNOWN_SCHEMA_ID = "UNKNOWN_SCHEMA_ID",
  UNKNOWN_SCHEMA_VERSION = "UNKNOWN_SCHEMA_VERSION",
  SCHEMA_VALIDATION_FAILED = "SCHEMA_VALIDATION_FAILED",
  MISSING_PAYLOAD = "MISSING_PAYLOAD",
  MALFORMED_ENVELOPE = "MALFORMED_ENVELOPE"
}

/**
 * Quarantine job data structure.
 * Sent to dead-letter queue when validation fails.
 */
export const quarantineJobDataSchema = z.object({
  sourceJobId: z.string().describe("Original job ID"),
  sourceQueue: z.string().describe("Original queue name"),
  sourceJobName: z.string().describe("Original job name"),
  schemaVersion: z.string().optional().describe("Schema version from envelope (if present)"),
  schemaId: z.string().optional().describe("Schema ID from envelope (if present)"),
  rawPayload: z.record(z.unknown()).describe("Raw unvalidated payload"),
  reason: z.nativeEnum(QuarantineReason).describe("Why the job was quarantined"),
  validationErrors: z
    .array(z.object({
      path: z.array(z.union([z.string(), z.number()])).describe("Path to invalid field"),
      message: z.string().describe("Validation error message")
    }))
    .optional()
    .describe("Zod validation errors if applicable"),
  timestamp: z.string().datetime().describe("ISO 8601 timestamp when quarantined"),
  traceparent: z.string().optional().describe("W3C Trace Context for correlation")
});

export type QuarantineJobData = z.infer<typeof quarantineJobDataSchema>;
