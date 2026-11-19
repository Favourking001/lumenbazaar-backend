import { describe, expect, it, vi } from "vitest";

import { buildWebhookPayload, type SellerStatusResolver } from "@lumenbazaar/shared";
import { type PrismaClient } from "@prisma/client";

import { handleResourceIndexing } from "./resourceIndexing.js";
import { handleSearchSync } from "./searchSync.js";
import { deliverWebhook, type WebhookDeliveryJobInput } from "./webhookDelivery.js";

const suspended: SellerStatusResolver = async () => ({
  status: "suspended",
  suspendedAt: "2026-11-19T08:00:00.000Z",
  suspensionReason: "operator review"
});

const active: SellerStatusResolver = async () => ({
  status: "active",
  suspendedAt: null,
  suspensionReason: null
});

function webhookInput(sellerId: string): WebhookDeliveryJobInput {
  return {
    eventId: "event_1",
    endpointId: "endpoint_1",
    sellerId,
    url: "https://seller.example/hook",
    payload: buildWebhookPayload(
      "event_1",
      "settlement.finalized",
      {
        id: "settlement_1",
        paymentAttemptId: "attempt_1",
        status: "settled",
        network: "stellar:testnet",
        amount: "1",
        assetCode: "USDC",
        assetIssuer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        transactionHash: null,
        failureCode: null,
        failureReason: null
      },
      "2026-11-19T08:00:00.000Z"
    ),
    secret: "test-secret",
    attemptNumber: 0
  };
}

describe("seller suspension enforcement (worker)", () => {
  it("skips webhook delivery for a suspended seller without contacting the endpoint or retrying", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must not be called for a suspended seller");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await deliverWebhook(webhookInput("seller_suspended"), {
        resolveSellerStatus: suspended
      });
      expect(result).toMatchObject({
        success: false,
        errorClass: "SELLER_SUSPENDED",
        shouldRetry: false
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("delivers webhooks for active sellers (delivery itself is unchanged)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 }))
    );
    try {
      const result = await deliverWebhook(webhookInput("seller_active"), {
        resolveSellerStatus: active
      });
      expect(result).toMatchObject({ success: true, shouldRetry: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips resource indexing for a suspended seller's resource without failing the job", async () => {
    const upsert = vi.fn(async () => ({}));
    const createEvent = vi.fn(async () => ({}));
    const db = {
      resource: {
        findUnique: async () => ({
          id: "resource_1",
          sellerId: "seller_suspended",
          name: "Weather API",
          description: "Weather data",
          type: "http",
          network: "stellar:testnet",
          assetCode: "USDC",
          routeTemplate: "/weather/{city}",
          inputSchema: {},
          outputSchema: {},
          extensions: {}
        })
      },
      searchDocument: { upsert },
      catalogEvent: { create: createEvent }
    } as unknown as PrismaClient;
    const job = {
      data: { resourceId: "resource_1", versionId: "version_1" },
      log: vi.fn()
    } as never;

    await expect(
      handleResourceIndexing(job as never, { db, resolveSellerStatus: suspended })
    ).resolves.toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("indexes resources for active sellers", async () => {
    const upsert = vi.fn(async () => ({}));
    const createEvent = vi.fn(async () => ({}));
    const db = {
      resource: {
        findUnique: async () => ({
          id: "resource_1",
          sellerId: "seller_active",
          name: "Weather API",
          description: "Weather data",
          type: "http",
          network: "stellar:testnet",
          assetCode: "USDC",
          routeTemplate: "/weather/{city}",
          inputSchema: {},
          outputSchema: {},
          extensions: {}
        })
      },
      searchDocument: { upsert },
      catalogEvent: { create: createEvent }
    } as unknown as PrismaClient;
    const job = {
      data: { resourceId: "resource_1", versionId: "version_1" },
      log: vi.fn()
    } as never;

    await handleResourceIndexing(job as never, { db, resolveSellerStatus: active });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("skips suspended sellers' resources during a search rebuild and counts them", async () => {
    const upsert = vi.fn(async () => ({}));
    const createEvent = vi.fn(async () => ({}));
    const resources = [
      {
        id: "resource_suspended",
        sellerId: "seller_suspended",
        name: "Suspended API",
        description: "Suspended",
        type: "http",
        network: "stellar:testnet",
        assetCode: "USDC",
        routeTemplate: "/suspended",
        inputSchema: {},
        outputSchema: {},
        extensions: {}
      },
      {
        id: "resource_active",
        sellerId: "seller_active",
        name: "Active API",
        description: "Active",
        type: "http",
        network: "stellar:testnet",
        assetCode: "USDC",
        routeTemplate: "/active",
        inputSchema: {},
        outputSchema: {},
        extensions: {}
      }
    ];
    const db = {
      resource: { findMany: async () => resources },
      searchDocument: { upsert },
      catalogEvent: { create: createEvent }
    } as unknown as PrismaClient;
    const job = {
      data: { action: "rebuild" },
      log: vi.fn()
    } as never;
    const resolver: SellerStatusResolver = async (sellerId) =>
      sellerId === "seller_suspended"
        ? {
            status: "suspended",
            suspendedAt: "2026-11-19T08:00:00.000Z",
            suspensionReason: "operator review"
          }
        : { status: "active", suspendedAt: null, suspensionReason: null };

    await handleSearchSync(job as never, { db, resolveSellerStatus: resolver });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { resourceId: "resource_active" } })
    );
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ indexedCount: 1, skippedSuspendedCount: 1 })
        })
      })
    );
  });
});
