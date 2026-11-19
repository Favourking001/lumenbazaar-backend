import { describe, it, expect } from "vitest";

import {
  parseVersion,
  isVersionCompatible,
  validateEnvelope,
  validatePayload,
  validateJobEnvelope,
  createJobEnvelope
} from "./validation.js";
import {
  JOB_SCHEMA_VERSION,
  schemaIds,
  QuarantineReason,
  type SettlementConfirmationPayload,
  type ResourceIndexingPayload,
  type WebhookDeliveryPayload
} from "./schemas.js";

// ============================================================================
// Version Parsing Tests
// ============================================================================

describe("parseVersion", () => {
  it("parses valid semantic versions", () => {
    expect(parseVersion("1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseVersion("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseVersion("2.5.10")).toEqual({ major: 2, minor: 5, patch: 10 });
  });

  it("returns null for invalid versions", () => {
    expect(parseVersion("1.0")).toBeNull();
    expect(parseVersion("1.0.0.0")).toBeNull();
    expect(parseVersion("a.b.c")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("isVersionCompatible", () => {
  it("accepts same major version", () => {
    expect(isVersionCompatible("1.0.0")).toBe(true);
    expect(isVersionCompatible("1.1.0")).toBe(true);
    expect(isVersionCompatible("1.99.99")).toBe(true);
  });

  it("rejects different major versions", () => {
    expect(isVersionCompatible("0.0.0")).toBe(false);
    expect(isVersionCompatible("2.0.0")).toBe(false);
    expect(isVersionCompatible("0.99.99")).toBe(false);
  });

  it("rejects invalid versions", () => {
    expect(isVersionCompatible("invalid")).toBe(false);
    expect(isVersionCompatible("1.0")).toBe(false);
  });
});

// ============================================================================
// Envelope Validation Tests
// ============================================================================

describe("validateEnvelope", () => {
  it("accepts valid envelopes", () => {
    const envelope = {
      schemaVersion: "1.0.0",
      schemaId: schemaIds.resourceIndexing,
      payload: { resourceId: "r1", versionId: "v1" }
    };
    const result = validateEnvelope(envelope);
    expect(result.success).toBe(true);
  });

  it("rejects envelopes with missing schemaVersion", () => {
    const envelope = {
      schemaId: schemaIds.resourceIndexing,
      payload: { resourceId: "r1", versionId: "v1" }
    };
    const result = validateEnvelope(envelope);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toBe(QuarantineReason.MALFORMED_ENVELOPE);
    }
  });

  it("rejects envelopes with missing schemaId", () => {
    const envelope = {
      schemaVersion: "1.0.0",
      payload: { resourceId: "r1", versionId: "v1" }
    };
    const result = validateEnvelope(envelope);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toBe(QuarantineReason.MALFORMED_ENVELOPE);
    }
  });

  it("rejects envelopes with missing payload", () => {
    const envelope = {
      schemaVersion: "1.0.0",
      schemaId: schemaIds.resourceIndexing
    };
    const result = validateEnvelope(envelope);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toBe(QuarantineReason.MALFORMED_ENVELOPE);
    }
  });

  it("accepts optional traceparent", () => {
    const envelope = {
      schemaVersion: "1.0.0",
      schemaId: schemaIds.resourceIndexing,
      payload: { resourceId: "r1", versionId: "v1" },
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
    };
    const result = validateEnvelope(envelope);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Payload Validation Tests
// ============================================================================

describe("validatePayload", () => {
  it("validates settlement confirmation payloads", () => {
    const payload: SettlementConfirmationPayload = {
      correlationId: "trace-123",
      paymentAttemptId: "attempt-abc",
      settlementId: "settlement-xyz",
      transactionHash: "hash123",
      network: "stellar:pubnet"
    };
    const result = validatePayload(schemaIds.settlementConfirmation, payload);
    expect(result.success).toBe(true);
  });

  it("validates resource indexing payloads", () => {
    const payload: ResourceIndexingPayload = {
      resourceId: "resource-123",
      versionId: "v1.2.3"
    };
    const result = validatePayload(schemaIds.resourceIndexing, payload);
    expect(result.success).toBe(true);
  });

  it("rejects unknown schema IDs", () => {
    const payload = { someField: "value" };
    const result = validatePayload("unknown-schema" as any, payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toBe(QuarantineReason.UNKNOWN_SCHEMA_ID);
    }
  });

  it("rejects invalid settlement confirmation payloads (missing network)", () => {
    const payload = {
      correlationId: "trace-123",
      paymentAttemptId: "attempt-abc"
      // Missing network
    };
    const result = validatePayload(schemaIds.settlementConfirmation, payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toBe(QuarantineReason.SCHEMA_VALIDATION_FAILED);
      expect(result.error.validationErrors).toBeDefined();
    }
  });

  it("rejects webhook delivery payloads with invalid URL", () => {
    const payload = {
      eventId: "evt-123",
      endpointId: "ep-456",
      sellerId: "seller-789",
      url: "not-a-url", // Invalid URL
      payload: {},
      secret: "secret",
      attemptNumber: 0
    };
    const result = validatePayload(schemaIds.webhookDelivery, payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toBe(QuarantineReason.SCHEMA_VALIDATION_FAILED);
    }
  });

  it("validates webhook delivery payloads with all fields", () => {
    const payload: WebhookDeliveryPayload = {
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
      previousSecrets: ["old-secret"],
      attemptNumber: 0
    };
    const result = validatePayload(schemaIds.webhookDelivery, payload);
    expect(result.success).toBe(true);
  });

  it("validates network health with required enum values", () => {
    const result1 = validatePayload(schemaIds.networkHealth, { network: "stellar:testnet" });
    expect(result1.success).toBe(true);

    const result2 = validatePayload(schemaIds.networkHealth, { network: "stellar:pubnet" });
    expect(result2.success).toBe(true);

    const result3 = validatePayload(schemaIds.networkHealth, { network: "invalid:network" });
    expect(result3.success).toBe(false);
  });
});

// ============================================================================
// Full Envelope Validation Tests
// ============================================================================

describe("validateJobEnvelope", () => {
  it("validates complete valid envelopes", () => {
    const envelope = {
      schemaVersion: JOB_SCHEMA_VERSION,
      schemaId: schemaIds.resourceIndexing,
      payload: {
        resourceId: "resource-123",
        versionId: "v1.2.3"
      }
    };
    const result = validateJobEnvelope(envelope);
    expect(result.success).toBe(true);
  });

  it("rejects malformed envelopes", () => {
    const result = validateJobEnvelope({ notAnEnvelope: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toBe(QuarantineReason.MALFORMED_ENVELOPE);
    }
  });

  it("rejects incompatible schema versions", () => {
    const envelope = {
      schemaVersion: "2.0.0", // Incompatible major version
      schemaId: schemaIds.resourceIndexing,
      payload: {
        resourceId: "resource-123",
        versionId: "v1.2.3"
      }
    };
    const result = validateJobEnvelope(envelope);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toBe(QuarantineReason.UNKNOWN_SCHEMA_VERSION);
    }
  });

  it("rejects invalid payloads even with valid envelope structure", () => {
    const envelope = {
      schemaVersion: JOB_SCHEMA_VERSION,
      schemaId: schemaIds.resourceIndexing,
      payload: {
        resourceId: "resource-123"
        // Missing versionId
      }
    };
    const result = validateJobEnvelope(envelope);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toBe(QuarantineReason.SCHEMA_VALIDATION_FAILED);
    }
  });

  it("validates with optional traceparent", () => {
    const envelope = {
      schemaVersion: JOB_SCHEMA_VERSION,
      schemaId: schemaIds.resourceIndexing,
      payload: {
        resourceId: "resource-123",
        versionId: "v1.2.3"
      },
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
    };
    const result = validateJobEnvelope(envelope);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Envelope Creation Tests
// ============================================================================

describe("createJobEnvelope", () => {
  it("creates valid envelopes with all fields", () => {
    const payload: ResourceIndexingPayload = {
      resourceId: "resource-123",
      versionId: "v1.2.3"
    };
    const envelope = createJobEnvelope(schemaIds.resourceIndexing, payload, "trace-123");
    
    expect(envelope.schemaVersion).toBe(JOB_SCHEMA_VERSION);
    expect(envelope.schemaId).toBe(schemaIds.resourceIndexing);
    expect(envelope.payload).toEqual(payload);
    expect(envelope.traceparent).toBe("trace-123");
  });

  it("creates envelopes without traceparent", () => {
    const payload: ResourceIndexingPayload = {
      resourceId: "resource-123",
      versionId: "v1.2.3"
    };
    const envelope = createJobEnvelope(schemaIds.resourceIndexing, payload);
    
    expect(envelope.schemaVersion).toBe(JOB_SCHEMA_VERSION);
    expect(envelope.schemaId).toBe(schemaIds.resourceIndexing);
    expect(envelope.payload).toEqual(payload);
    expect(envelope.traceparent).toBeUndefined();
  });

  it("preserves all payload fields", () => {
    const payload: SettlementConfirmationPayload = {
      correlationId: "trace-123",
      paymentAttemptId: "attempt-abc",
      settlementId: "settlement-xyz",
      transactionHash: "hash123",
      network: "stellar:pubnet"
    };
    const envelope = createJobEnvelope(schemaIds.settlementConfirmation, payload);
    
    expect(envelope.payload).toEqual(payload);
  });

  it("created envelopes pass validation", () => {
    const payload: ResourceIndexingPayload = {
      resourceId: "resource-123",
      versionId: "v1.2.3"
    };
    const envelope = createJobEnvelope(schemaIds.resourceIndexing, payload);
    
    const result = validateJobEnvelope(envelope);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("Validation Round Trip", () => {
  it("validates settlement confirmation end-to-end", () => {
    const payload: SettlementConfirmationPayload = {
      correlationId: "trace-123",
      paymentAttemptId: "attempt-abc",
      settlementId: "settlement-xyz",
      transactionHash: "hash123",
      network: "stellar:pubnet"
    };

    // Create envelope
    const envelope = createJobEnvelope(schemaIds.settlementConfirmation, payload);

    // Validate envelope
    const result = validateJobEnvelope(envelope);
    expect(result.success).toBe(true);

    if (result.success) {
      const validated = result.payload;
      expect(validated.payload).toEqual(payload);
      expect(validated.schemaId).toBe(schemaIds.settlementConfirmation);
    }
  });

  it("validates webhook delivery with complex payload end-to-end", () => {
    const payload: WebhookDeliveryPayload = {
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
      secret: "secret-key",
      previousSecrets: ["old-secret-1", "old-secret-2"],
      attemptNumber: 3
    };

    // Create envelope
    const envelope = createJobEnvelope(schemaIds.webhookDelivery, payload);

    // Validate envelope
    const result = validateJobEnvelope(envelope);
    expect(result.success).toBe(true);

    if (result.success) {
      const validated = result.payload;
      expect(validated.payload).toEqual(payload);
    }
  });

  it("validates all job types", () => {
    const testCases = [
      {
        schemaId: schemaIds.settlementConfirmation,
        payload: {
          paymentAttemptId: "attempt-123",
          network: "stellar:pubnet"
        }
      },
      {
        schemaId: schemaIds.resourceIndexing,
        payload: { resourceId: "r-1", versionId: "v-1" }
      },
      {
        schemaId: schemaIds.searchSync,
        payload: { action: "rebuild" as const }
      },
      {
        schemaId: schemaIds.networkHealth,
        payload: { network: "stellar:testnet" as const }
      },
      {
        schemaId: schemaIds.receiptFinalizer,
        payload: { action: "finalize_pending" as const }
      },
      {
        schemaId: schemaIds.stalePaymentCleanup,
        payload: { action: "cleanup_expired" as const }
      },
      {
        schemaId: schemaIds.outboxRelay,
        payload: {}
      },
      {
        schemaId: schemaIds.outboxCleanup,
        payload: {}
      }
    ];

    for (const testCase of testCases) {
      const envelope = createJobEnvelope(testCase.schemaId, testCase.payload as any);
      const result = validateJobEnvelope(envelope);
      expect(result.success).toBe(true, `Failed for ${testCase.schemaId}`);
    }
  });
});

// ============================================================================
// Error Message Tests
// ============================================================================

describe("Error Messages", () => {
  it("provides useful error messages for missing required fields", () => {
    const result = validatePayload(schemaIds.resourceIndexing, {
      resourceId: "r-1"
      // Missing versionId
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("validation failed");
      expect(result.error.validationErrors).toBeDefined();
      expect(result.error.validationErrors!.length).toBeGreaterThan(0);
    }
  });

  it("provides useful error messages for wrong types", () => {
    const result = validatePayload(schemaIds.networkHealth, {
      network: 123 // Should be string
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("validation failed");
    }
  });

  it("provides useful error messages for invalid enums", () => {
    const result = validatePayload(schemaIds.searchSync, {
      action: "invalid_action" // Should be "rebuild" or "mark_stale"
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.validationErrors).toBeDefined();
      expect(result.error.validationErrors!.length).toBeGreaterThan(0);
    }
  });
});
