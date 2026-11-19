/**
 * Schema migration utilities for handling payloads from older API versions.
 *
 * This module provides functions to detect and migrate legacy (pre-v1.0.0) payloads
 * to the current versioned envelope format. When the queue receives a payload without
 * a schemaVersion or schemaId (pre-migration payloads), these functions can:
 *
 * 1. Detect the payload type based on field structure
 * 2. Wrap it in the current version envelope
 * 3. Apply any necessary field transformations
 *
 * Migration strategy:
 * - v0 payloads are identified by the absence of schemaVersion/schemaId
 * - Migration is attempted in dequeue validation
 * - If migration succeeds, the job continues processing
 * - If migration fails, the job is quarantined with migration_failed reason
 */

import { schemaIds, type SchemaId } from "./schemas.js";

// ============================================================================
// v0 Payload Detection
// ============================================================================

/**
 * Detect if a payload is a v0 (pre-versioned) payload.
 * V0 payloads lack schemaVersion and schemaId fields.
 *
 * @param data - Raw payload
 * @returns true if this appears to be a v0 payload
 */
export function isV0Payload(data: Record<string, unknown>): boolean {
  return typeof data.schemaVersion !== "string" && typeof data.schemaId !== "string";
}

/**
 * Infer the schema ID from a v0 payload structure.
 * Uses field presence and types to guess which job type this is.
 *
 * @param data - Raw v0 payload
 * @returns Schema ID or null if cannot determine
 */
export function inferSchemaIdFromV0Payload(data: Record<string, unknown>): SchemaId | null {
  // Settlement confirmation: has paymentAttemptId, network, correlationId/settlementId/transactionHash
  if (
    typeof data.paymentAttemptId === "string" &&
    typeof data.network === "string" &&
    (typeof data.correlationId === "string" || typeof data.settlementId === "string" ||
      typeof data.transactionHash === "string" || data.correlationId === undefined)
  ) {
    return schemaIds.settlementConfirmation;
  }

  // Resource indexing: has resourceId, versionId
  if (typeof data.resourceId === "string" && typeof data.versionId === "string") {
    return schemaIds.resourceIndexing;
  }

  // Search sync: has action in ["rebuild", "mark_stale"], optional resourceId, network
  if (
    (data.action === "rebuild" || data.action === "mark_stale") &&
    (typeof data.resourceId === "string" || data.resourceId === undefined) &&
    (typeof data.network === "string" || data.network === undefined)
  ) {
    return schemaIds.searchSync;
  }

  // Network health: has network in ["stellar:testnet", "stellar:pubnet"]
  if (data.network === "stellar:testnet" || data.network === "stellar:pubnet") {
    // Additional check: network health v0 payloads have ONLY network field
    if (
      Object.keys(data).length === 1 ||
      (Object.keys(data).length === 2 && typeof data.traceparent === "string")
    ) {
      return schemaIds.networkHealth;
    }
  }

  // Receipt finalizer: has action in ["finalize_pending", "finalize_by_settlement", "retry_failed"]
  if (
    data.action === "finalize_pending" ||
    data.action === "finalize_by_settlement" ||
    data.action === "retry_failed"
  ) {
    return schemaIds.receiptFinalizer;
  }

  // Stale payment cleanup: has action in ["cleanup_expired", "cleanup_failed", "archive"]
  if (
    data.action === "cleanup_expired" ||
    data.action === "cleanup_failed" ||
    data.action === "archive"
  ) {
    return schemaIds.stalePaymentCleanup;
  }

  // Webhook delivery: has eventId, endpointId, sellerId, url, payload, secret, attemptNumber
  if (
    typeof data.eventId === "string" &&
    typeof data.endpointId === "string" &&
    typeof data.sellerId === "string" &&
    typeof data.url === "string" &&
    data.payload !== undefined &&
    typeof data.secret === "string" &&
    typeof data.attemptNumber === "number"
  ) {
    return schemaIds.webhookDelivery;
  }

  // Outbox relay: empty or only has traceparent
  if (
    (Object.keys(data).length === 0 ||
      (Object.keys(data).length === 1 && typeof data.traceparent === "string"))
  ) {
    return schemaIds.outboxRelay;
  }

  // Outbox cleanup: has retentionDays or is empty
  if (
    typeof data.retentionDays === "number" ||
    data.retentionDays === undefined
  ) {
    // Could be outboxCleanup, but be conservative
    if (
      (Object.keys(data).length === 0 ||
        Object.keys(data).length === 1 ||
        (Object.keys(data).length === 2 && typeof data.traceparent === "string")) &&
      typeof data.retentionDays !== "string"
    ) {
      return schemaIds.outboxCleanup;
    }
  }

  return null;
}

// ============================================================================
// v0 to v1.0.0 Migration
// ============================================================================

/**
 * Migrate a v0 payload to v1.0.0 format.
 * Wraps the payload in a versioned envelope and applies any necessary transformations.
 *
 * @param data - v0 payload
 * @returns Migrated v1.0.0 envelope or null if migration failed
 */
export function migrateV0ToV1(data: Record<string, unknown>): Record<string, unknown> | null {
  // Try to infer the schema ID
  const schemaId = inferSchemaIdFromV0Payload(data);
  if (!schemaId) {
    return null;
  }

  // Extract traceparent if present (existed in v0)
  const traceparent = typeof data.traceparent === "string" ? data.traceparent : undefined;

  // Create the v1.0.0 envelope
  const envelope: Record<string, unknown> = {
    schemaVersion: "1.0.0",
    schemaId,
    payload: data
  };

  if (traceparent) {
    envelope.traceparent = traceparent;
  }

  return envelope;
}

// ============================================================================
// Migration Fixtures (for testing)
// ============================================================================

/**
 * V0 payload fixtures - example payloads from before versioning was added.
 * Used for testing migration logic and handler compatibility.
 */
export const v0PayloadFixtures = {
  // Settlement confirmation v0 payload
  settlementConfirmationV0: {
    correlationId: "trace-123",
    paymentAttemptId: "attempt-abc123",
    settlementId: "settlement-xyz789",
    transactionHash: "abc123def456",
    network: "stellar:pubnet",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  } as Record<string, unknown>,

  // Resource indexing v0 payload
  resourceIndexingV0: {
    resourceId: "resource-123",
    versionId: "v1.2.3",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  } as Record<string, unknown>,

  // Search sync v0 payload
  searchSyncV0: {
    action: "rebuild",
    resourceId: undefined,
    network: undefined,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  } as Record<string, unknown>,

  // Network health v0 payload
  networkHealthV0: {
    network: "stellar:testnet",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  } as Record<string, unknown>,

  // Receipt finalizer v0 payload
  receiptFinalizerV0: {
    action: "finalize_pending",
    settlementId: undefined,
    maxAge: 3600000,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  } as Record<string, unknown>,

  // Stale payment cleanup v0 payload
  stalePaymentCleanupV0: {
    action: "cleanup_expired",
    maxAgeMs: 604800000,
    policy: undefined,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  } as Record<string, unknown>,

  // Webhook delivery v0 payload
  webhookDeliveryV0: {
    eventId: "evt-abc123",
    endpointId: "ep-xyz789",
    sellerId: "seller-123",
    url: "https://example.com/webhooks",
    payload: {
      schemaVersion: "1.0.0",
      eventId: "evt-abc123",
      eventType: "settlement.pending",
      timestamp: "2024-01-15T12:00:00Z",
      paymentId: "pay-123",
      settlementId: "settlement-xyz789",
      status: "pending",
      network: "stellar:testnet",
      amount: "1000000",
      assetCode: "USDC",
      assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTHENA5H7I7KYHU7G2G5YJJMP"
    },
    secret: "secret-key-12345",
    previousSecrets: [],
    attemptNumber: 0,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  } as Record<string, unknown>,

  // Outbox relay v0 payload
  outboxRelayV0: {
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  } as Record<string, unknown>,

  // Outbox cleanup v0 payload
  outboxCleanupV0: {
    retentionDays: 30,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  } as Record<string, unknown>
};

/**
 * Expected v1.0.0 envelopes after migration from v0 fixtures.
 * Used to verify migration output.
 */
export const migratedV1Envelopes = {
  settlementConfirmation: {
    schemaVersion: "1.0.0",
    schemaId: "settlement-confirmation",
    payload: v0PayloadFixtures.settlementConfirmationV0,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  },

  resourceIndexing: {
    schemaVersion: "1.0.0",
    schemaId: "resource-indexing",
    payload: v0PayloadFixtures.resourceIndexingV0,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  },

  searchSync: {
    schemaVersion: "1.0.0",
    schemaId: "search-sync",
    payload: v0PayloadFixtures.searchSyncV0,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  },

  networkHealth: {
    schemaVersion: "1.0.0",
    schemaId: "network-health",
    payload: v0PayloadFixtures.networkHealthV0,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  },

  receiptFinalizer: {
    schemaVersion: "1.0.0",
    schemaId: "receipt-finalizer",
    payload: v0PayloadFixtures.receiptFinalizerV0,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  },

  stalePaymentCleanup: {
    schemaVersion: "1.0.0",
    schemaId: "stale-payment-cleanup",
    payload: v0PayloadFixtures.stalePaymentCleanupV0,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  },

  webhookDelivery: {
    schemaVersion: "1.0.0",
    schemaId: "webhook-delivery",
    payload: v0PayloadFixtures.webhookDeliveryV0,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  },

  outboxRelay: {
    schemaVersion: "1.0.0",
    schemaId: "outbox-relay",
    payload: v0PayloadFixtures.outboxRelayV0,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  },

  outboxCleanup: {
    schemaVersion: "1.0.0",
    schemaId: "outbox-cleanup",
    payload: v0PayloadFixtures.outboxCleanupV0,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
  }
};
