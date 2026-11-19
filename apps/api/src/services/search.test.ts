import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  encodeCursor,
  loadConfig,
  localIssuerPublicKey,
  maxSearchQueryTerms
} from "@lumenbazaar/shared";

import { InMemoryResourceStore, ResourceService, type ListResourceFilters } from "./resources.js";
import { SearchService } from "./search.js";
import { SellerService } from "./sellers.js";

/** Store that fails loudly if search reaches the database layer. */
class GuardedResourceStore extends InMemoryResourceStore {
  override async listResources(
    _filters: ListResourceFilters
  ): Promise<{ resources: never[]; nextCursor: null }> {
    throw new Error("listResources must not run for a rejected query");
  }
}

async function createWeatherResource(resourceService: ResourceService, sellerId: string) {
  return resourceService.createResource({
    sellerId,
    type: "http",
    name: "Paid Weather API",
    description: "Returns current weather and forecast data for a city.",
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
      type: "object",
      properties: {
        temperature: {
          type: "number"
        }
      }
    },
    extensions: {
      bazaar: true
    }
  });
}

describe("SearchService", () => {
  it("indexes and ranks resources by natural language-like query terms", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(loadConfig({}), sellerService);
    const searchService = new SearchService(resourceService);
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });

    await createWeatherResource(resourceService, seller.id);

    await searchService.rebuildIndex();

    await expect(searchService.search({ q: "weather forecast", limit: 5 })).resolves.toMatchObject({
      resources: [
        {
          name: "Paid Weather API",
          ranking: {
            matchedTerms: ["weather", "forecast"]
          }
        }
      ],
      ranking: {
        strategy: "postgres-full-text-v1"
      },
      partialResults: false,
      nextCursor: null
    });
  });

  it("rejects a page size above the maximum before touching the store", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(
      loadConfig({}),
      sellerService,
      new GuardedResourceStore()
    );
    const searchService = new SearchService(resourceService);

    await expect(searchService.search({ q: "weather", limit: 101 })).rejects.toMatchObject({
      code: "PAGE_SIZE_EXCEEDED",
      statusCode: 400
    });
  });

  it("rejects an adversarial query without executing it", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(
      loadConfig({}),
      sellerService,
      new GuardedResourceStore()
    );
    const searchService = new SearchService(resourceService);
    const q = Array.from({ length: maxSearchQueryTerms }, (_, i) => `term${i}`).join(" ");

    await expect(
      searchService.search({
        q,
        network: "stellar:testnet",
        asset: "USDC",
        type: "http",
        sellerId: "seller_1",
        limit: 100
      })
    ).rejects.toMatchObject({
      code: "QUERY_TOO_COMPLEX",
      statusCode: 422
    });
  });

  it("rejects a query with more terms than the maximum", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(
      loadConfig({}),
      sellerService,
      new GuardedResourceStore()
    );
    const searchService = new SearchService(resourceService);
    const q = Array.from({ length: maxSearchQueryTerms + 1 }, (_, i) => `term${i}`).join(" ");

    await expect(searchService.search({ q })).rejects.toMatchObject({
      code: "QUERY_TOO_COMPLEX",
      statusCode: 422
    });
  });

  it("accepts a maximum page size query and returns ranked results", async () => {
    const sellerService = new SellerService();
    // Seed the store directly: ResourceService.createResource rejects the
    // synthetic USDC issuer in this sandbox's config, which is unrelated
    // to the search limits under test.
    const store = new InMemoryResourceStore();
    const resourceService = new ResourceService(loadConfig({}), sellerService, store);
    const searchService = new SearchService(resourceService);
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });

    await store.createResource({
      sellerId: seller.id,
      type: "http",
      name: "Paid Weather API",
      description: "Returns current weather and forecast data for a city.",
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
        type: "object",
        properties: {
          temperature: {
            type: "number"
          }
        }
      },
      extensions: {
        bazaar: true
      },
      status: "active"
    });
    await searchService.rebuildIndex();

    const result = await searchService.search({ q: "weather", limit: 100 });

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]?.name).toBe("Paid Weather API");
    expect(result.nextCursor).toBeNull();
  });

  it("round-trips cursors carrying result-window depth", () => {
    const cursor = encodeCursor({
      id: "resource_1",
      createdAt: "2026-09-03T00:00:00.000Z",
      depth: 250
    });

    expect(decodeCursor(cursor)).toEqual({
      id: "resource_1",
      createdAt: "2026-09-03T00:00:00.000Z",
      depth: 250
    });
  });
});
