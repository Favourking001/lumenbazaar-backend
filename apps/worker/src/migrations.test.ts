import { describe, it, expect } from "vitest";

import {
  isV0Payload,
  inferSchemaIdFromV0Payload,
  migrateV0ToV1,
  v0PayloadFixtures,
  migratedV1Envelopes
} from "./migrations.js";
import { schemaIds } from "./schemas.js";
import { validateJobEnvelope } from "./validation.js";

// ============================================================================
// V0 Payload Detection Tests
// ============================================================================

describe("isV0Payload", () => {
  it("detects v0 payloads (no schemaVersion or schemaId)", () => {
    expect(isV0Payload({ resourceId: "r1", versionId: "v1" })).toBe(true);
    expect(isV0Payload({ paymentAttemptId: "p1", network: "stellar:pubnet" })).toBe(true);
  });

  it("rejects v1 payloads with schemaVersion", () => {
    expect(
      isV0Payload({
        schemaVersion: "1.0.0",
        schemaId: "resource-indexing",
        payload: {}
      })
    ).toBe(false);
  });

  it("rejects v1 payloads with schemaId", () => {
    expect(
      isV0Payload({
        schemaId: "resource-indexing",
        resourceId: "r1",
        versionId: "v1"
      })
    ).toBe(false);
  });

  it("detects v0 payloads with traceparent", () => {
    expect(
      isV0Payload({
        resourceId: "r1",
        versionId: "v1",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
      })
    ).toBe(true);
  });
});

// ============================================================================
// Schema ID Inference Tests
// ============================================================================

describe("inferSchemaIdFromV0Payload", () => {
  it("infers settlement confirmation schema ID", () => {
    const result = inferSchemaIdFromV0Payload(v0PayloadFixtures.settlementConfirmationV0);
    expect(result).toBe(schemaIds.settlementConfirmation);
  });

  it("infers resource indexing schema ID", () => {
    const result = inferSchemaIdFromV0Payload(v0PayloadFixtures.resourceIndexingV0);
    expect(result).toBe(schemaIds.resourceIndexing);
  });

  it("infers search sync schema ID", () => {
    const result = inferSchemaIdFromV0Payload(v0PayloadFixtures.searchSyncV0);
    expect(result).toBe(schemaIds.searchSync);
  });

  it("infers network health schema ID", () => {
    const result = inferSchemaIdFromV0Payload(v0PayloadFixtures.networkHealthV0);
    expect(result).toBe(schemaIds.networkHealth);
  });

  it("infers receipt finalizer schema ID", () => {
    const result = inferSchemaIdFromV0Payload(v0PayloadFixtures.receiptFinalizerV0);
    expect(result).toBe(schemaIds.receiptFinalizer);
  });

  it("infers stale payment cleanup schema ID", () => {
    const result = inferSchemaIdFromV0Payload(v0PayloadFixtures.stalePaymentCleanupV0);
    expect(result).toBe(schemaIds.stalePaymentCleanup);
  });

  it("infers webhook delivery schema ID", () => {
    const result = inferSchemaIdFromV0Payload(v0PayloadFixtures.webhookDeliveryV0);
    expect(result).toBe(schemaIds.webhookDelivery);
  });

  it("infers outbox relay schema ID", () => {
    const result = inferSchemaIdFromV0Payload(v0PayloadFixtures.outboxRelayV0);
    expect(result).toBe(schemaIds.outboxRelay);
  });

  it("infers outbox cleanup schema ID", () => {
    const result = inferSchemaIdFromV0Payload(v0PayloadFixtures.outboxCleanupV0);
    expect(result).toBe(schemaIds.outboxCleanup);
  });

  it("returns null for unknown payload types", () => {
    const result = inferSchemaIdFromV0Payload({
      unknownField: "value",
      anotherField: 123
    });
    expect(result).toBeNull();
  });

  it("disambiguates between network-only payloads", () => {
    // Network health v0 should have ONLY network field (or network + traceparent)
    const networkHealthPayload = {
      network: "stellar:testnet",
      traceparent: "00-trace"
    };
    expect(inferSchemaIdFromV0Payload(networkHealthPayload)).toBe(
      schemaIds.networkHealth
    );

    // But search sync with network field is different
    const searchSyncPayload = {
      action: "rebuild",
      network: "stellar:testnet"
    };
    expect(inferSchemaIdFromV0Payload(searchSyncPayload)).toBe(schemaIds.searchSync);
  });
});

// ============================================================================
// V0 to V1 Migration Tests
// ============================================================================

describe("migrateV0ToV1", () => {
  it("migrates settlement confirmation v0 to v1", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.settlementConfirmationV0);
    expect(migrated).toBeDefined();
    expect(migrated?.schemaVersion).toBe("1.0.0");
    expect(migrated?.schemaId).toBe(schemaIds.settlementConfirmation);
    expect(migrated?.payload).toEqual(v0PayloadFixtures.settlementConfirmationV0);
    expect(migrated?.traceparent).toBe(
      v0PayloadFixtures.settlementConfirmationV0.traceparent
    );
  });

  it("migrates resource indexing v0 to v1", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.resourceIndexingV0);
    expect(migrated).toBeDefined();
    expect(migrated?.schemaId).toBe(schemaIds.resourceIndexing);
  });

  it("migrates search sync v0 to v1", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.searchSyncV0);
    expect(migrated).toBeDefined();
    expect(migrated?.schemaId).toBe(schemaIds.searchSync);
  });

  it("migrates network health v0 to v1", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.networkHealthV0);
    expect(migrated).toBeDefined();
    expect(migrated?.schemaId).toBe(schemaIds.networkHealth);
  });

  it("migrates receipt finalizer v0 to v1", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.receiptFinalizerV0);
    expect(migrated).toBeDefined();
    expect(migrated?.schemaId).toBe(schemaIds.receiptFinalizer);
  });

  it("migrates stale payment cleanup v0 to v1", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.stalePaymentCleanupV0);
    expect(migrated).toBeDefined();
    expect(migrated?.schemaId).toBe(schemaIds.stalePaymentCleanup);
  });

  it("migrates webhook delivery v0 to v1", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.webhookDeliveryV0);
    expect(migrated).toBeDefined();
    expect(migrated?.schemaId).toBe(schemaIds.webhookDelivery);
  });

  it("migrates outbox relay v0 to v1", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.outboxRelayV0);
    expect(migrated).toBeDefined();
    expect(migrated?.schemaId).toBe(schemaIds.outboxRelay);
  });

  it("migrates outbox cleanup v0 to v1", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.outboxCleanupV0);
    expect(migrated).toBeDefined();
    expect(migrated?.schemaId).toBe(schemaIds.outboxCleanup);
  });

  it("returns null for unknown payload types", () => {
    const result = migrateV0ToV1({
      unknownField: "value",
      anotherField: 123
    });
    expect(result).toBeNull();
  });

  it("preserves traceparent during migration", () => {
    const v0Payload = {
      resourceId: "r-1",
      versionId: "v-1",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01"
    };
    const migrated = migrateV0ToV1(v0Payload);
    expect(migrated?.traceparent).toBe(v0Payload.traceparent);
  });

  it("omits traceparent when not present in v0", () => {
    const v0Payload = {
      resourceId: "r-1",
      versionId: "v-1"
    };
    const migrated = migrateV0ToV1(v0Payload);
    expect(migrated?.traceparent).toBeUndefined();
  });
});

// ============================================================================
// Migration Validation Tests
// ============================================================================

describe("Migrated Envelopes Validate", () => {
  it("validates migrated settlement confirmation envelope", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.settlementConfirmationV0);
    expect(migrated).toBeDefined();
    const result = validateJobEnvelope(migrated!);
    expect(result.success).toBe(true);
  });

  it("validates migrated resource indexing envelope", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.resourceIndexingV0);
    expect(migrated).toBeDefined();
    const result = validateJobEnvelope(migrated!);
    expect(result.success).toBe(true);
  });

  it("validates migrated search sync envelope", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.searchSyncV0);
    expect(migrated).toBeDefined();
    const result = validateJobEnvelope(migrated!);
    expect(result.success).toBe(true);
  });

  it("validates migrated network health envelope", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.networkHealthV0);
    expect(migrated).toBeDefined();
    const result = validateJobEnvelope(migrated!);
    expect(result.success).toBe(true);
  });

  it("validates migrated receipt finalizer envelope", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.receiptFinalizerV0);
    expect(migrated).toBeDefined();
    const result = validateJobEnvelope(migrated!);
    expect(result.success).toBe(true);
  });

  it("validates migrated stale payment cleanup envelope", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.stalePaymentCleanupV0);
    expect(migrated).toBeDefined();
    const result = validateJobEnvelope(migrated!);
    expect(result.success).toBe(true);
  });

  it("validates migrated webhook delivery envelope", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.webhookDeliveryV0);
    expect(migrated).toBeDefined();
    const result = validateJobEnvelope(migrated!);
    expect(result.success).toBe(true);
  });

  it("validates migrated outbox relay envelope", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.outboxRelayV0);
    expect(migrated).toBeDefined();
    const result = validateJobEnvelope(migrated!);
    expect(result.success).toBe(true);
  });

  it("validates migrated outbox cleanup envelope", () => {
    const migrated = migrateV0ToV1(v0PayloadFixtures.outboxCleanupV0);
    expect(migrated).toBeDefined();
    const result = validateJobEnvelope(migrated!);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Fixture Consistency Tests
// ============================================================================

describe("Fixture Consistency", () => {
  it("v0 fixtures match expected migration output", () => {
    const fixtures = [
      {
        v0: v0PayloadFixtures.settlementConfirmationV0,
        expected: migratedV1Envelopes.settlementConfirmation
      },
      {
        v0: v0PayloadFixtures.resourceIndexingV0,
        expected: migratedV1Envelopes.resourceIndexing
      },
      {
        v0: v0PayloadFixtures.searchSyncV0,
        expected: migratedV1Envelopes.searchSync
      },
      {
        v0: v0PayloadFixtures.networkHealthV0,
        expected: migratedV1Envelopes.networkHealth
      },
      {
        v0: v0PayloadFixtures.receiptFinalizerV0,
        expected: migratedV1Envelopes.receiptFinalizer
      },
      {
        v0: v0PayloadFixtures.stalePaymentCleanupV0,
        expected: migratedV1Envelopes.stalePaymentCleanup
      },
      {
        v0: v0PayloadFixtures.webhookDeliveryV0,
        expected: migratedV1Envelopes.webhookDelivery
      },
      {
        v0: v0PayloadFixtures.outboxRelayV0,
        expected: migratedV1Envelopes.outboxRelay
      },
      {
        v0: v0PayloadFixtures.outboxCleanupV0,
        expected: migratedV1Envelopes.outboxCleanup
      }
    ];

    for (const { v0, expected } of fixtures) {
      const migrated = migrateV0ToV1(v0);
      expect(migrated).toEqual(expected);
    }
  });

  it("all v0 fixtures are detected as v0", () => {
    const allV0Fixtures = Object.values(v0PayloadFixtures);
    for (const fixture of allV0Fixtures) {
      // Remove traceparent for detection test
      const { traceparent, ...withoutTraceparent } = fixture;
      expect(isV0Payload(withoutTraceparent)).toBe(true);
    }
  });

  it("all v1 envelopes have correct structure", () => {
    const allV1Envelopes = Object.values(migratedV1Envelopes);
    for (const envelope of allV1Envelopes) {
      expect(envelope).toHaveProperty("schemaVersion", "1.0.0");
      expect(envelope).toHaveProperty("schemaId");
      expect(envelope).toHaveProperty("payload");
      expect(envelope).toHaveProperty("traceparent");
    }
  });
});
