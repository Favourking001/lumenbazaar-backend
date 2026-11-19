import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Job } from "bullmq";

import { createJobEnvelope, validateJobEnvelope, schemaIds } from "@lumenbazaar/shared";

import {
  type SettlementConfirmationJobData,
  type ResourceIndexingJobData,
  type SearchSyncJobData,
  type NetworkHealthJobData,
  type ReceiptFinalizerJobData,
  type StalePaymentCleanupJobData,
  type WebhookDeliveryJobInput
} from "./workers/index.js";
import {
  type OutboxRelayJobData,
  type OutboxCleanupJobData
} from "./workers/index.js";

// ============================================================================
// Integration Test Suite: Enqueue → Validate → Handler Flow
// ============================================================================

describe("Integration: Job Envelope Creation and Validation", () => {
  describe("Settlement Confirmation Flow", () => {
    it("creates valid envelope at enqueue and validates at dequeue", () => {
      const payload: SettlementConfirmationJobData = {
        correlationId: "trace-123",
        paymentAttemptId: "attempt-abc",
        settlementId: "settlement-xyz",
        transactionHash: "hash123",
        network: "stellar:pubnet"
      };

      // Enqueue: wrap in envelope
      const envelope = createJobEnvelope(schemaIds.settlementConfirmation, payload);

      // Dequeue: validate envelope
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.payload.schemaId).toBe(schemaIds.settlementConfirmation);
        expect(result.payload.payload).toEqual(payload);
      }
    });

    it("preserves optional fields through envelope round-trip", () => {
      const payload: SettlementConfirmationJobData = {
        paymentAttemptId: "attempt-abc",
        network: "stellar:testnet"
        // correlationId, settlementId, transactionHash omitted
      };

      const envelope = createJobEnvelope(schemaIds.settlementConfirmation, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.payload.payload).toEqual(payload);
      }
    });
  });

  describe("Resource Indexing Flow", () => {
    it("creates valid envelope and preserves all fields", () => {
      const payload: ResourceIndexingJobData = {
        resourceId: "resource-123",
        versionId: "v1.2.3"
      };

      const envelope = createJobEnvelope(schemaIds.resourceIndexing, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.payload.payload).toEqual(payload);
      }
    });
  });

  describe("Search Sync Flow", () => {
    it("validates rebuild action with optional fields", () => {
      const payload: SearchSyncJobData = {
        action: "rebuild"
        // resourceId and network omitted
      };

      const envelope = createJobEnvelope(schemaIds.searchSync, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("validates mark_stale action with resource ID", () => {
      const payload: SearchSyncJobData = {
        action: "mark_stale",
        resourceId: "resource-123"
      };

      const envelope = createJobEnvelope(schemaIds.searchSync, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("validates mark_stale with network filter", () => {
      const payload: SearchSyncJobData = {
        action: "mark_stale",
        network: "stellar:testnet"
      };

      const envelope = createJobEnvelope(schemaIds.searchSync, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });
  });

  describe("Network Health Flow", () => {
    it("validates testnet network health check", () => {
      const payload: NetworkHealthJobData = {
        network: "stellar:testnet"
      };

      const envelope = createJobEnvelope(schemaIds.networkHealth, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("validates mainnet network health check", () => {
      const payload: NetworkHealthJobData = {
        network: "stellar:pubnet"
      };

      const envelope = createJobEnvelope(schemaIds.networkHealth, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("rejects invalid network", () => {
      const payload = {
        network: "invalid:network"
      };

      const envelope = createJobEnvelope(schemaIds.networkHealth, payload as any);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(false);
    });
  });

  describe("Receipt Finalizer Flow", () => {
    it("validates finalize_pending action", () => {
      const payload: ReceiptFinalizerJobData = {
        action: "finalize_pending"
      };

      const envelope = createJobEnvelope(schemaIds.receiptFinalizer, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("validates finalize_by_settlement with ID", () => {
      const payload: ReceiptFinalizerJobData = {
        action: "finalize_by_settlement",
        settlementId: "settlement-123"
      };

      const envelope = createJobEnvelope(schemaIds.receiptFinalizer, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("validates retry_failed with max age", () => {
      const payload: ReceiptFinalizerJobData = {
        action: "retry_failed",
        maxAge: 3600000
      };

      const envelope = createJobEnvelope(schemaIds.receiptFinalizer, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });
  });

  describe("Stale Payment Cleanup Flow", () => {
    it("validates cleanup_expired action", () => {
      const payload: StalePaymentCleanupJobData = {
        action: "cleanup_expired"
      };

      const envelope = createJobEnvelope(schemaIds.stalePaymentCleanup, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("validates cleanup_failed with max age", () => {
      const payload: StalePaymentCleanupJobData = {
        action: "cleanup_failed",
        maxAgeMs: 604800000 // 7 days
      };

      const envelope = createJobEnvelope(schemaIds.stalePaymentCleanup, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("validates archive with policy override", () => {
      const payload: StalePaymentCleanupJobData = {
        action: "archive",
        policy: {
          cleanup: { maxAgeMs: 86400000 }
        }
      };

      const envelope = createJobEnvelope(schemaIds.stalePaymentCleanup, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });
  });

  describe("Webhook Delivery Flow", () => {
    it("creates and validates webhook delivery with minimal payload", () => {
      const payload: WebhookDeliveryJobInput = {
        eventId: "evt-123",
        endpointId: "ep-456",
        sellerId: "seller-789",
        url: "https://example.com/webhooks",
        payload: {
          schemaVersion: "1.0.0",
          eventId: "evt-123",
          eventType: "settlement.pending",
          timestamp: "2024-01-15T12:00:00Z",
          paymentId: "pay-123",
          settlementId: "settlement-xyz",
          status: "pending",
          network: "stellar:testnet",
          amount: "1000000",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTHENA5H7I7KYHU7G2G5YJJMP"
        },
        secret: "secret-key",
        attemptNumber: 0
      };

      const envelope = createJobEnvelope(schemaIds.webhookDelivery, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("validates webhook delivery with previous secrets", () => {
      const payload: WebhookDeliveryJobInput = {
        eventId: "evt-123",
        endpointId: "ep-456",
        sellerId: "seller-789",
        url: "https://example.com/webhooks",
        payload: {
          schemaVersion: "1.0.0",
          eventId: "evt-123",
          eventType: "settlement.finalized",
          timestamp: "2024-01-15T12:00:00Z",
          paymentId: "pay-123",
          settlementId: "settlement-xyz",
          status: "confirmed",
          network: "stellar:testnet",
          amount: "1000000",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTHENA5H7I7KYHU7G2G5YJJMP",
          transactionHash: "abc123def456"
        },
        secret: "current-secret",
        previousSecrets: ["old-secret-1", "old-secret-2"],
        attemptNumber: 2
      };

      const envelope = createJobEnvelope(schemaIds.webhookDelivery, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.payload.payload).toEqual(payload);
      }
    });

    it("rejects webhook delivery with invalid URL", () => {
      const payload = {
        eventId: "evt-123",
        endpointId: "ep-456",
        sellerId: "seller-789",
        url: "not-a-url",
        payload: {},
        secret: "secret",
        attemptNumber: 0
      };

      const envelope = createJobEnvelope(schemaIds.webhookDelivery, payload as any);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(false);
    });
  });

  describe("Outbox Relay Flow", () => {
    it("creates and validates empty outbox relay envelope", () => {
      const payload: OutboxRelayJobData = {};

      const envelope = createJobEnvelope(schemaIds.outboxRelay, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });
  });

  describe("Outbox Cleanup Flow", () => {
    it("creates and validates outbox cleanup with default retention", () => {
      const payload: OutboxCleanupJobData = {};

      const envelope = createJobEnvelope(schemaIds.outboxCleanup, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("creates and validates outbox cleanup with custom retention", () => {
      const payload: OutboxCleanupJobData = {
        retentionDays: 60
      };

      const envelope = createJobEnvelope(schemaIds.outboxCleanup, payload);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(true);
    });

    it("rejects outbox cleanup with invalid retention (zero)", () => {
      const payload = {
        retentionDays: 0
      };

      const envelope = createJobEnvelope(schemaIds.outboxCleanup, payload as any);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(false);
    });

    it("rejects outbox cleanup with invalid retention (negative)", () => {
      const payload = {
        retentionDays: -1
      };

      const envelope = createJobEnvelope(schemaIds.outboxCleanup, payload as any);
      const result = validateJobEnvelope(envelope);

      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Integration Test Suite: Distributed Tracing
// ============================================================================

describe("Integration: Distributed Tracing Through Envelopes", () => {
  const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01";

  it("preserves W3C trace context for settlement confirmation", () => {
    const payload: SettlementConfirmationJobData = {
      paymentAttemptId: "attempt-abc",
      network: "stellar:pubnet"
    };

    const envelope = createJobEnvelope(
      schemaIds.settlementConfirmation,
      payload,
      traceparent
    );

    expect(envelope.traceparent).toBe(traceparent);

    const result = validateJobEnvelope(envelope);
    expect(result.success).toBe(true);
  });

  it("preserves W3C trace context for resource indexing", () => {
    const payload: ResourceIndexingJobData = {
      resourceId: "resource-123",
      versionId: "v1.2.3"
    };

    const envelope = createJobEnvelope(
      schemaIds.resourceIndexing,
      payload,
      traceparent
    );

    expect(envelope.traceparent).toBe(traceparent);

    const result = validateJobEnvelope(envelope);
    expect(result.success).toBe(true);
  });

  it("omits traceparent when not provided", () => {
    const payload: ResourceIndexingJobData = {
      resourceId: "resource-123",
      versionId: "v1.2.3"
    };

    const envelope = createJobEnvelope(schemaIds.resourceIndexing, payload);

    expect(envelope.traceparent).toBeUndefined();

    const result = validateJobEnvelope(envelope);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Integration Test Suite: Version Information in Envelopes
// ============================================================================

describe("Integration: Schema Version Information", () => {
  it("all envelopes include schema version", () => {
    const payloads = [
      {
        schemaId: schemaIds.settlementConfirmation as const,
        payload: { paymentAttemptId: "p1", network: "stellar:pubnet" }
      },
      {
        schemaId: schemaIds.resourceIndexing as const,
        payload: { resourceId: "r1", versionId: "v1" }
      },
      {
        schemaId: schemaIds.searchSync as const,
        payload: { action: "rebuild" as const }
      },
      {
        schemaId: schemaIds.networkHealth as const,
        payload: { network: "stellar:testnet" as const }
      },
      {
        schemaId: schemaIds.receiptFinalizer as const,
        payload: { action: "finalize_pending" as const }
      },
      {
        schemaId: schemaIds.stalePaymentCleanup as const,
        payload: { action: "cleanup_expired" as const }
      },
      {
        schemaId: schemaIds.outboxRelay as const,
        payload: {}
      },
      {
        schemaId: schemaIds.outboxCleanup as const,
        payload: {}
      }
    ];

    for (const { schemaId, payload } of payloads) {
      const envelope = createJobEnvelope(schemaId, payload as any);
      expect(envelope.schemaVersion).toBe("1.0.0");
      expect(envelope.schemaId).toBe(schemaId);
    }
  });

  it("version information enables handler routing", () => {
    // In a real handler, this would be used to route to the correct handler
    const payload: SettlementConfirmationJobData = {
      paymentAttemptId: "p1",
      network: "stellar:pubnet"
    };

    const envelope = createJobEnvelope(schemaIds.settlementConfirmation, payload);

    // Simulate handler routing based on schemaId
    const handlersMap: Record<string, string> = {
      [schemaIds.settlementConfirmation]: "handleSettlementConfirmation",
      [schemaIds.resourceIndexing]: "handleResourceIndexing",
      [schemaIds.searchSync]: "handleSearchSync",
      [schemaIds.networkHealth]: "handleNetworkHealth",
      [schemaIds.receiptFinalizer]: "handleReceiptFinalizer",
      [schemaIds.stalePaymentCleanup]: "handleStalePaymentCleanup",
      [schemaIds.webhookDelivery]: "handleWebhookDelivery",
      [schemaIds.outboxRelay]: "handleOutboxRelay",
      [schemaIds.outboxCleanup]: "handleOutboxCleanup"
    };

    const handler = handlersMap[envelope.schemaId as string];
    expect(handler).toBe("handleSettlementConfirmation");
  });
});

// ============================================================================
// Integration Test Suite: Payload Round-Trips
// ============================================================================

describe("Integration: Payload Preservation", () => {
  it("settlement confirmation payload survives round-trip", () => {
    const original: SettlementConfirmationJobData = {
      correlationId: "trace-123",
      paymentAttemptId: "attempt-abc",
      settlementId: "settlement-xyz",
      transactionHash: "hash123",
      network: "stellar:pubnet"
    };

    const envelope = createJobEnvelope(schemaIds.settlementConfirmation, original);
    const result = validateJobEnvelope(envelope);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.payload.payload).toEqual(original);
    }
  });

  it("webhook delivery payload survives round-trip with nested objects", () => {
    const original: WebhookDeliveryJobInput = {
      eventId: "evt-123",
      endpointId: "ep-456",
      sellerId: "seller-789",
      url: "https://example.com/webhooks",
      payload: {
        schemaVersion: "1.0.0",
        eventId: "evt-123",
        eventType: "settlement.pending",
        timestamp: "2024-01-15T12:00:00Z",
        paymentId: "pay-123",
        settlementId: "settlement-xyz",
        status: "pending",
        network: "stellar:testnet",
        amount: "1000000",
        assetCode: "USDC",
        assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTHENA5H7I7KYHU7G2G5YJJMP"
      },
      secret: "secret",
      previousSecrets: ["old-secret"],
      attemptNumber: 5
    };

    const envelope = createJobEnvelope(schemaIds.webhookDelivery, original);
    const result = validateJobEnvelope(envelope);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.payload.payload).toEqual(original);
    }
  });

  it("all optional fields are preserved", () => {
    const original: ReceiptFinalizerJobData = {
      action: "finalize_by_settlement",
      settlementId: "settlement-123",
      maxAge: 7200000
    };

    const envelope = createJobEnvelope(schemaIds.receiptFinalizer, original);
    const result = validateJobEnvelope(envelope);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.payload.payload.settlementId).toBe("settlement-123");
      expect(result.payload.payload.maxAge).toBe(7200000);
    }
  });
});
