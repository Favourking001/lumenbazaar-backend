import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, localIssuerPublicKey } from "@lumenbazaar/shared";

import { buildApiApp } from "../app.js";
import { InMemoryResourceStore, ResourceService } from "../services/resources.js";
import { SellerService } from "../services/sellers.js";

const resourceInput = (sellerId: string) => ({
  sellerId,
  type: "http" as const,
  name: "Paid Weather API",
  description: "Returns current weather and forecast data for a city.",
  url: "https://seller.example/weather/Lagos",
  routeTemplate: "/weather/{city}",
  network: "stellar:testnet" as const,
  payTo: localIssuerPublicKey,
  assetCode: "USDC",
  assetIssuer: localIssuerPublicKey,
  amount: "0.05",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
  outputSchema: { type: "object", properties: { temperature: { type: "number" } } },
  extensions: { bazaar: true },
  status: "active" as const
});

describe("catalog conditional requests", () => {
  let app: ReturnType<typeof buildApiApp>;
  let store: InMemoryResourceStore;
  let resourceId: string;
  let sellerId: string;

  beforeEach(async () => {
    const sellerService = new SellerService();
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    sellerId = seller.id;
    store = new InMemoryResourceStore();
    const resource = await store.createResource(resourceInput(sellerId));
    resourceId = resource.id;
    const resourceService = new ResourceService(loadConfig({}), sellerService, store);
    app = buildApiApp({ logger: false, sellerService, resourceService });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns a strong ETag and public cache headers for a single resource", async () => {
    const response = await app.inject({ method: "GET", url: `/v1/resources/${resourceId}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
    expect(response.json().id).toBe(resourceId);
  });

  it("returns 304 with cache headers and no body on a matching If-None-Match", async () => {
    const first = await app.inject({ method: "GET", url: `/v1/resources/${resourceId}` });
    const etag = first.headers.etag as string;

    const second = await app.inject({
      method: "GET",
      url: `/v1/resources/${resourceId}`,
      headers: { "if-none-match": etag }
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expect(second.headers.etag).toBe(etag);
    expect(second.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("returns 304 for If-None-Match: * and for weak or listed tags", async () => {
    const first = await app.inject({ method: "GET", url: `/v1/resources/${resourceId}` });
    const etag = first.headers.etag as string;

    for (const ifNoneMatch of ["*", `W/${etag}`, `"nope", ${etag}`]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/resources/${resourceId}`,
        headers: { "if-none-match": ifNoneMatch }
      });
      expect(response.statusCode).toBe(304);
      expect(response.body).toBe("");
    }
  });

  it("returns 200 for a non-matching If-None-Match", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/resources/${resourceId}`,
      headers: {
        "if-none-match": '"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(resourceId);
  });

  it("changes the ETag when the resource changes", async () => {
    const before = await app.inject({ method: "GET", url: `/v1/resources/${resourceId}` });
    await store.updateResource(resourceId, { name: "Paid Weather API v2" }, { expectedVersion: 1 });

    const after = await app.inject({ method: "GET", url: `/v1/resources/${resourceId}` });

    expect(after.headers.etag).not.toBe(before.headers.etag);
    const stale = await app.inject({
      method: "GET",
      url: `/v1/resources/${resourceId}`,
      headers: { "if-none-match": before.headers.etag as string }
    });
    expect(stale.statusCode).toBe(200);
  });

  it("supports conditional reads for the resource list", async () => {
    const first = await app.inject({ method: "GET", url: "/v1/resources" });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(first.headers["cache-control"]).toBe("public, max-age=60");

    const second = await app.inject({
      method: "GET",
      url: "/v1/resources",
      headers: { "if-none-match": first.headers.etag as string }
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it("supports conditional reads for discovery browse and search", async () => {
    for (const url of ["/v1/discovery/resources", "/v1/discovery/search?q=weather"]) {
      const first = await app.inject({ method: "GET", url });
      expect(first.statusCode).toBe(200);
      expect(first.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect(first.headers["cache-control"]).toBe("public, max-age=60");

      const second = await app.inject({
        method: "GET",
        url,
        headers: { "if-none-match": first.headers.etag as string }
      });
      expect(second.statusCode).toBe(304);
      expect(second.body).toBe("");
      expect(second.headers.etag).toBe(first.headers.etag);
      expect(second.headers["cache-control"]).toBe("public, max-age=60");
    }
  });

  it("does not emit a shared validator for version history", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/resources/${resourceId}/versions`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("X-Api-Key");
  });

  it("does not emit a shared validator for a single version or seller resources", async () => {
    const version = await app.inject({
      method: "GET",
      url: `/v1/resources/${resourceId}/versions/1`
    });
    expect(version.statusCode).toBe(200);
    expect(version.headers.etag).toBeUndefined();
    expect(version.headers["cache-control"]).toBe("private, no-store");

    const sellerResources = await app.inject({
      method: "GET",
      url: `/v1/sellers/${sellerId}/resources`
    });
    expect(sellerResources.statusCode).toBe(200);
    expect(sellerResources.headers.etag).toBeUndefined();
    expect(sellerResources.headers["cache-control"]).toBe("private, no-store");
    expect(sellerResources.headers.vary).toBe("X-Api-Key");
  });
});
