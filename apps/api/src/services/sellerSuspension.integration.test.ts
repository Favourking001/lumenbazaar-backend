import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, localIssuerPublicKey } from "@lumenbazaar/shared";

import { PrismaResourceStore, PrismaSellerStore } from "./catalogPersistence.js";
import { ResourceService } from "./resources.js";
import { SellerService } from "./sellers.js";

/**
 * Durable seller-suspension checks. Skipped without a database (the sandbox
 * has no Postgres); run in CI with CATALOG_PERSISTENCE_TEST_DATABASE_URL
 * pointing at a migrated test database.
 */
const databaseUrl = process.env.CATALOG_PERSISTENCE_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

function createClient() {
  return new PrismaClient({ datasources: { db: { url: databaseUrl as string } } });
}

describePostgres("durable seller suspension", () => {
  let client: PrismaClient;

  beforeEach(async () => {
    client = createClient();
    await client.seller.deleteMany();
  });

  afterEach(async () => {
    await client.$disconnect();
  });

  it("persists suspension state and blocks writes until reinstatement", async () => {
    const sellerService = new SellerService(new PrismaSellerStore(client));
    const resourceService = new ResourceService(
      loadConfig({ TESTNET_ASSET: "lbt" }),
      sellerService,
      new PrismaResourceStore(client)
    );
    const seller = await sellerService.createSeller({
      displayName: "Durable Tools",
      walletAddress: localIssuerPublicKey,
      domain: "tools.example"
    });

    expect(seller.status).toBe("active");

    const suspended = await sellerService.suspendSeller(seller.id, "operator review");
    expect(suspended.status).toBe("suspended");
    expect(suspended.suspendedAt).not.toBeNull();

    // Re-reading through a fresh store sees the same suspended state.
    const reread = await new SellerService(new PrismaSellerStore(client)).getSeller(seller.id);
    expect(reread.status).toBe("suspended");
    expect(reread.suspensionReason).toBe("operator review");

    await expect(
      resourceService.createResource({
        sellerId: seller.id,
        type: "http",
        name: "Paid Weather API",
        description: "Returns current weather for a city.",
        url: "https://tools.example/weather/Lagos",
        routeTemplate: "/weather/{city}",
        network: "stellar:testnet",
        payTo: localIssuerPublicKey,
        assetCode: "lbt",
        assetIssuer: localIssuerPublicKey,
        amount: "0.0500000",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        extensions: {}
      })
    ).rejects.toMatchObject({ code: "SELLER_SUSPENDED" });

    const reinstated = await sellerService.reinstateSeller(seller.id);
    expect(reinstated.status).toBe("active");
    expect(reinstated.suspendedAt).toBeNull();
  });
});
