import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  encodeCursor,
  loadConfig,
  localIssuerPublicKey,
  maxResultWindow
} from "@lumenbazaar/shared";

import { DiscoveryService } from "./discovery.js";
import { InMemoryResourceStore, ResourceService, type ListResourceFilters } from "./resources.js";
import { SellerService } from "./sellers.js";

/** Store that fails loudly if browse reaches the database layer. */
class GuardedResourceStore extends InMemoryResourceStore {
  override async listResources(
    _filters: ListResourceFilters
  ): Promise<{ resources: never[]; nextCursor: null }> {
    throw new Error("listResources must not run for a rejected query");
  }
}

describe("DiscoveryService", () => {
  it("browses resources with deterministic filters and pagination metadata", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(loadConfig({}), sellerService);
    const discoveryService = new DiscoveryService(resourceService);
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });

    await resourceService.createResource({
      sellerId: seller.id,
      type: "http",
      name: "Paid Weather API",
      description: "Returns current weather for a city.",
      url: "https://seller.example/weather/Lagos",
      routeTemplate: "/weather/{city}",
      network: "stellar:testnet",
      payTo: localIssuerPublicKey,
      assetCode: "USDC",
      assetIssuer: localIssuerPublicKey,
      amount: "0.05",
      inputSchema: {
        type: "object",
        properties: {
          city: {
            type: "string"
          }
        }
      },
      outputSchema: {
        type: "object"
      },
      extensions: {
        bazaar: true
      }
    });

    await expect(
      discoveryService.browse({
        network: "stellar:testnet",
        asset: "USDC",
        type: "http",
        sellerId: seller.id,
        minPrice: "0.01",
        maxPrice: "0.10",
        extension: "bazaar"
      })
    ).resolves.toMatchObject({
      resources: [
        {
          name: "Paid Weather API"
        }
      ],
      nextCursor: null,
      partialResults: false
    });
  });

  it("rejects a browse page size above the maximum before touching the store", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(
      loadConfig({}),
      sellerService,
      new GuardedResourceStore()
    );
    const discoveryService = new DiscoveryService(resourceService);

    await expect(discoveryService.browse({ limit: 500 })).rejects.toMatchObject({
      code: "PAGE_SIZE_EXCEEDED",
      statusCode: 400
    });
  });

  it("rejects paging at or beyond the maximum result window", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(loadConfig({}), sellerService);
    const discoveryService = new DiscoveryService(resourceService);
    const cursor = encodeCursor({
      id: "resource_1",
      createdAt: "2026-09-03T00:00:00.000Z",
      depth: maxResultWindow
    });

    await expect(discoveryService.browse({ cursor })).rejects.toMatchObject({
      code: "RESULT_WINDOW_EXCEEDED",
      statusCode: 400
    });
  });

  it("tracks result-window depth in cursors across pages", async () => {
    const sellerService = new SellerService();
    // Seed the store directly: ResourceService.createResource rejects the
    // synthetic USDC issuer in this sandbox's config, which is unrelated
    // to the pagination limits under test.
    const store = new InMemoryResourceStore();
    const resourceService = new ResourceService(loadConfig({}), sellerService, store);
    const discoveryService = new DiscoveryService(resourceService);
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });

    for (const name of ["Weather One", "Weather Two", "Weather Three"]) {
      await store.createResource({
        sellerId: seller.id,
        type: "http",
        name,
        description: "Returns current weather for a city.",
        url: "https://seller.example/weather/Lagos",
        routeTemplate: "/weather/{city}",
        network: "stellar:testnet",
        payTo: localIssuerPublicKey,
        assetCode: "USDC",
        assetIssuer: localIssuerPublicKey,
        amount: "0.05",
        inputSchema: {
          type: "object",
          properties: {
            city: {
              type: "string"
            }
          }
        },
        outputSchema: {
          type: "object"
        },
        extensions: {
          bazaar: true
        },
        status: "active"
      });
    }

    const first = await discoveryService.browse({ limit: 1 });
    expect(first.resources).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeCursor(first.nextCursor ?? undefined)?.depth).toBe(1);

    const second = await discoveryService.browse({
      limit: 1,
      cursor: first.nextCursor ?? undefined
    });
    expect(second.resources).toHaveLength(1);
    expect(second.resources[0]?.id).not.toBe(first.resources[0]?.id);
    expect(decodeCursor(second.nextCursor ?? undefined)?.depth).toBe(2);

    const third = await discoveryService.browse({
      limit: 1,
      cursor: second.nextCursor ?? undefined
    });
    expect(third.resources).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
  });
});
