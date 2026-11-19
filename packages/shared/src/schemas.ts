/**
 * Job payload schemas for worker queue validation.
 * 
 * This module re-exports type definitions and schema registries from the worker
 * package to enable shared validation between API (enqueue) and worker (dequeue).
 * 
 * Both producers and consumers use the same schemas to validate payloads at
 * their respective boundaries, ensuring consistency and early error detection.
 */

// Re-export everything from worker schemas
// This allows API code to import from @lumenbazaar/shared instead of
// directly depending on @lumenbazaar/worker

export type {
  SettlementConfirmationPayload,
  ResourceIndexingPayload,
  SearchSyncPayload,
  NetworkHealthPayload,
  ReceiptFinalizerPayload,
  StalePaymentCleanupPayload,
  WebhookDeliveryPayload,
  OutboxRelayPayload,
  OutboxCleanupPayload,
  PayloadBySchemaId,
  AnyJobPayload,
  QuarantineJobData,
  SchemaId
} from "@lumenbazaar/worker";

export {
  JOB_SCHEMA_VERSION,
  schemaIds,
  settlementConfirmationSchemaV1,
  resourceIndexingSchemaV1,
  searchSyncSchemaV1,
  networkHealthSchemaV1,
  receiptFinalizerSchemaV1,
  stalePaymentCleanupSchemaV1,
  webhookDeliverySchemaV1,
  outboxRelaySchemaV1,
  outboxCleanupSchemaV1,
  schemaRegistry,
  jobEnvelopeSchema,
  QuarantineReason,
  quarantineJobDataSchema
} from "@lumenbazaar/worker";
