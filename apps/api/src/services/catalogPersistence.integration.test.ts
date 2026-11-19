import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, localIssuerPublicKey } from "@lumenbazaar/shared";

import {
  PrismaCatalogEventStore,
  PrismaResourceStore,
  PrismaSearchDocumentStore,
  PrismaSellerStore
} from "./catalogPersistence.js";
import { InMemoryResourceIndexingQueue } from "./cataloging.js";
import { DiscoveryService } from "./discovery.js";
import { ResourceService } from "./resources.js";
import { SearchService } from "./search.js";
import { SellerService } from "./sellers.js";

const databaseUrl = process.env.CATALOG_PERSISTENCE_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("durable catalog persistence", () => {
  let client: PrismaClient;

  beforeEach(async () => {
    client = createClient();
    await client.searchDocument.deleteMany();
    await client.catalogEvent.deleteMany();
    await client.paymentRequirement.deleteMany();
    await client.resourceSchema.deleteMany();
    await client.resourceVersion.deleteMany();
    await client.resource.deleteMany();
    await client.sellerDomain.deleteMany();
    await client.seller.deleteMany();
  });

  afterEach(async () => {
    await client.$disconnect();
  });

  it("survives restart, versions updates, reindexes, and hides disabled resources", async () => {
    const config = loadConfig({});
    const indexingQueue = new InMemoryResourceIndexingQueue();
    const sellerService = new SellerService(new PrismaSellerStore(client));
    const resourceService = new ResourceService(
      config,
      sellerService,
      new PrismaResourceStore(client),
      indexingQueue
    );
    const searchService = new SearchService(
      resourceService,
      undefined,
      new PrismaSearchDocumentStore(client)
    );
    const seller = await sellerService.createSeller({
      displayName: "Durable Tools",
      walletAddress: localIssuerPublicKey,
      domain: "tools.example"
    });
    const resource = await resourceService.createResource(resourceInput(seller.id));
    await searchService.indexResource(resource);
    await new PrismaCatalogEventStore(client).createCatalogEvent({
      resourceId: resource.id,
      sellerId: seller.id,
      type: "cataloged",
      status: "accepted",
      reason: null,
      metadata: { source: "integration" }
    });

    await client.$disconnect();
    client = createClient();
    const restartedSellers = new SellerService(new PrismaSellerStore(client));
    const restartedResources = new ResourceService(
      config,
      restartedSellers,
      new PrismaResourceStore(client),
      indexingQueue
    );
    const restartedSearch = new SearchService(
      restartedResources,
      undefined,
      new PrismaSearchDocumentStore(client)
    );

    await expect(restartedResources.getResource(resource.id)).resolves.toMatchObject({
      name: "Text Statistics",
      amount: "0.05"
    });
    await expect(restartedSearch.search({ q: "text statistics" })).resolves.toMatchObject({
      resources: [{ id: resource.id }],
      partialResults: false
    });

    const updated = await restartedResources.updateResource(resource.id, {
      description: "Counts words, characters, and sentences in supplied text.",
      version: 1
    });
    await expect(
      client.resourceVersion.count({ where: { resourceId: resource.id } })
    ).resolves.toBe(2);
    await expect(
      client.searchDocument.findUniqueOrThrow({ where: { resourceId: resource.id } })
    ).resolves.toMatchObject({ stale: true });
    await restartedSearch.indexResource(updated);
    await restartedResources.deleteResource(resource.id, undefined, {
      expectedVersion: 2
    });

    await expect(new DiscoveryService(restartedResources).browse({})).resolves.toMatchObject({
      resources: []
    });
    await expect(restartedSearch.search({ q: "text" })).resolves.toMatchObject({ resources: [] });
    await expect(restartedResources.getResource(resource.id)).resolves.toMatchObject({
      status: "inactive"
    });
    expect(indexingQueue.jobs).toHaveLength(3);
    await expect(client.catalogEvent.count({ where: { resourceId: resource.id } })).resolves.toBe(
      1
    );
  });

  it("rejects a stale concurrent update without losing the winner's write (issue #102)", async () => {
    const config = loadConfig({});
    const indexingQueue = new InMemoryResourceIndexingQueue();
    const sellerService = new SellerService(new PrismaSellerStore(client));
    const resourceService = new ResourceService(
      config,
      sellerService,
      new PrismaResourceStore(client),
      indexingQueue
    );
    const seller = await sellerService.createSeller({
      displayName: "Concurrent Tools",
      walletAddress: localIssuerPublicKey,
      domain: "concurrent.example"
    });
    const resource = await resourceService.createResource(resourceInput(seller.id));
    expect(resource.version).toBe(1);

    // Two writers race with the same expected version: exactly one may win.
    const attempts = await Promise.allSettled([
      resourceService.updateResource(resource.id, { name: "writer A" }, undefined, {
        expectedVersion: 1
      }),
      resourceService.updateResource(resource.id, { name: "writer B" }, undefined, {
        expectedVersion: 1
      })
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const conflict = (rejected[0] as PromiseRejectedResult).reason as {
      code?: string;
      statusCode?: number;
      details?: Record<string, unknown>;
    };
    expect(conflict.code).toBe("RESOURCE_VERSION_CONFLICT");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.details).toMatchObject({ expectedVersion: 1, currentVersion: 2 });

    // No lost update: the stored row is exactly the winner's, at version 2,
    // and the history gained exactly one version.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ name: string }>).value;
    const stored = await client.resource.findUniqueOrThrow({ where: { id: resource.id } });
    expect(stored.version).toBe(2);
    expect(stored.name).toBe(winner.name);
    await expect(resourceService.getResource(resource.id)).resolves.toMatchObject({
      version: 2,
      name: winner.name
    });
    await expect(
      client.resourceVersion.count({ where: { resourceId: resource.id } })
    ).resolves.toBe(2);

    // A stale writer that re-reads first can still succeed with the new version.
    const retried = await resourceService.updateResource(
      resource.id,
      { name: "writer C" },
      undefined,
      { expectedVersion: 2 }
    );
    expect(retried.version).toBe(3);
  });
});

function resourceInput(sellerId: string) {
  return {
    sellerId,
    type: "http",
    name: "Text Statistics",
    description: "Counts words and characters in supplied text.",
    url: "https://api.tools.example/v1/examples/text-statistics/sample",
    routeTemplate: "/v1/examples/text-statistics/{text}",
    network: "stellar:testnet",
    payTo: localIssuerPublicKey,
    assetCode: "USDC",
    assetIssuer: localIssuerPublicKey,
    amount: "0.0500000",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } }
    },
    outputSchema: {
      type: "object",
      properties: { words: { type: "number" }, characters: { type: "number" } }
    },
    extensions: { bazaar: true }
  } as const;
}

function createClient() {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl ?? "postgresql://integration-test-is-disabled" } }
  });
}
