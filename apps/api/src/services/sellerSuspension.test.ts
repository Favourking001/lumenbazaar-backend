import { describe, expect, it } from "vitest";

import { loadConfig, localIssuerPublicKey, type SellerStatusResolver } from "@lumenbazaar/shared";

import { DiscoveryService } from "./discovery.js";
import { ResourceService } from "./resources.js";
import { SearchService } from "./search.js";
import { InMemorySellerApiKeyStore, SellerApiKeyService } from "./sellerApiKeys.js";
import { SellerService } from "./sellers.js";
import { WebhookService } from "./webhooks.js";

const activeInfo = {
  status: "active" as const,
  suspendedAt: null,
  suspensionReason: null
};

function resourceInput(sellerId: string) {
  return {
    sellerId,
    type: "http",
    name: "Paid Weather API",
    description: "Returns current weather for a city.",
    url: "https://seller.example/weather/Lagos",
    routeTemplate: "/weather/{city}",
    network: "stellar:testnet",
    payTo: localIssuerPublicKey,
    assetCode: "lbt",
    assetIssuer: localIssuerPublicKey,
    amount: "0.0500000",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } }
    },
    outputSchema: { type: "object" },
    extensions: { bazaar: true }
  };
}

/** Test config using the LBT test-only asset (issuer: local placeholder key). */
function testConfig() {
  return loadConfig({ TESTNET_ASSET: "lbt" });
}

async function suspendedSeller() {
  const sellerService = new SellerService();
  const seller = await sellerService.createSeller({
    displayName: "Weather Seller",
    walletAddress: localIssuerPublicKey,
    domain: "seller.example"
  });
  await sellerService.suspendSeller(seller.id, "operator review");
  return { sellerService, seller };
}

describe("seller suspension enforcement (API)", () => {
  it("creates sellers active and suspends/reinstates them with audit state", async () => {
    const sellerService = new SellerService();
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });

    expect(seller).toMatchObject({
      status: "active",
      suspendedAt: null,
      suspensionReason: null
    });
    await expect(sellerService.getSellerStatus(seller.id)).resolves.toEqual(activeInfo);

    const suspended = await sellerService.suspendSeller(seller.id, "operator review");
    expect(suspended.status).toBe("suspended");
    expect(suspended.suspendedAt).not.toBeNull();
    expect(suspended.suspensionReason).toBe("operator review");
    const status = await sellerService.getSellerStatus(seller.id);
    expect(status?.status).toBe("suspended");
    expect(status?.suspendedAt).not.toBeNull();
    expect(status?.suspensionReason).toBe("operator review");

    await expect(sellerService.requireActiveSeller(seller.id, "write")).rejects.toMatchObject({
      code: "SELLER_SUSPENDED",
      statusCode: 403
    });
    await expect(sellerService.requireActiveSeller(seller.id, "paid")).rejects.toMatchObject({
      code: "SELLER_SUSPENDED"
    });
    await expect(sellerService.requireActiveSeller(seller.id, "read")).resolves.toBeUndefined();
    await expect(sellerService.requireActiveSeller(seller.id, "recovery")).resolves.toBeUndefined();

    const reinstated = await sellerService.reinstateSeller(seller.id);
    expect(reinstated).toMatchObject({
      status: "active",
      suspendedAt: null,
      suspensionReason: null
    });
    await expect(sellerService.requireActiveSeller(seller.id, "write")).resolves.toBeUndefined();
  });

  it("blocks resource writes for a suspended seller but allows reads", async () => {
    const { sellerService, seller } = await suspendedSeller();
    const resourceService = new ResourceService(testConfig(), sellerService);

    await expect(resourceService.createResource(resourceInput(seller.id))).rejects.toMatchObject({
      code: "SELLER_SUSPENDED"
    });

    // A resource created before suspension stays readable but not writable.
    const activeService = new SellerService();
    const activeSeller = await activeService.createSeller({
      displayName: "Other Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    const writable = new ResourceService(testConfig(), activeService);
    const resource = await writable.createResource(resourceInput(activeSeller.id));
    await activeService.suspendSeller(activeSeller.id, "operator review");

    await expect(writable.getResource(resource.id)).resolves.toMatchObject({ id: resource.id });
    await expect(
      writable.updateResource(resource.id, { name: "Renamed", version: 1 })
    ).rejects.toMatchObject({ code: "SELLER_SUSPENDED" });
    await expect(
      writable.deleteResource(resource.id, undefined, { expectedVersion: 1 })
    ).rejects.toMatchObject({ code: "SELLER_SUSPENDED" });
    await expect(
      writable.rollbackResource(resource.id, 1, undefined, { expectedVersion: 1 })
    ).rejects.toMatchObject({ code: "SELLER_SUSPENDED" });
    await expect(writable.listResources({ sellerId: activeSeller.id })).resolves.toMatchObject({
      resources: [expect.objectContaining({ id: resource.id })]
    });
  });

  it("blocks new API keys and rotation for a suspended seller, allows revocation, and flags the principal", async () => {
    const { sellerService, seller } = await suspendedSeller();
    const resolver: SellerStatusResolver = (sellerId) => sellerService.getSellerStatus(sellerId);
    const keyService = new SellerApiKeyService(
      new InMemorySellerApiKeyStore(),
      undefined,
      undefined,
      resolver
    );

    await expect(
      keyService.createKey(seller.id, { name: "key", scopes: ["seller:read"] })
    ).rejects.toMatchObject({ code: "SELLER_SUSPENDED" });

    // Keys issued before suspension authenticate but carry the flag; the
    // enforcement hook (not authenticate) blocks their writes.
    const preSuspensionKeys = new SellerApiKeyService(new InMemorySellerApiKeyStore());
    const { key } = await preSuspensionKeys.createKey(seller.id, {
      name: "key",
      scopes: ["seller:read"]
    });
    const issued = await preSuspensionKeys.createKey(seller.id, {
      name: "revocable",
      scopes: ["seller:read"]
    });
    await sellerService.suspendSeller(seller.id, "operator review");
    const keyServiceWithStore = new SellerApiKeyService(
      preSuspensionKeys.getStore(),
      undefined,
      undefined,
      resolver
    );
    const principal = await keyServiceWithStore.authenticate(key);
    expect(principal.sellerSuspended).toBe(true);
    await expect(keyServiceWithStore.rotateKey(seller.id, issued.apiKey.id)).rejects.toMatchObject({
      code: "SELLER_SUSPENDED"
    });
    // Revocation is recovery: it stays available while suspended.
    await expect(keyServiceWithStore.revokeKey(seller.id, issued.apiKey.id)).resolves.toMatchObject(
      { status: "revoked" }
    );
  });

  it("blocks webhook creation, update, and secret rotation for a suspended seller, allows deletion", async () => {
    const { sellerService, seller } = await suspendedSeller();
    const resolver: SellerStatusResolver = (sellerId) => sellerService.getSellerStatus(sellerId);
    const webhookService = new WebhookService(undefined, undefined, resolver);

    await expect(
      webhookService.createWebhookEndpoint(seller.id, { url: "https://seller.example/hook" })
    ).rejects.toMatchObject({ code: "SELLER_SUSPENDED" });

    const activeService = new SellerService();
    const activeSeller = await activeService.createSeller({
      displayName: "Other Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    const preSuspension = new WebhookService();
    const endpoint = await preSuspension.createWebhookEndpoint(activeSeller.id, {
      url: "https://seller.example/hook"
    });
    await activeService.suspendSeller(activeSeller.id, "operator review");
    const gated = new WebhookService(preSuspension.getStore(), undefined, (sellerId: string) =>
      activeService.getSellerStatus(sellerId)
    );
    await expect(
      gated.updateWebhookEndpoint(activeSeller.id, endpoint.id, {
        url: "https://seller.example/hook2"
      })
    ).rejects.toMatchObject({ code: "SELLER_SUSPENDED" });
    await expect(gated.rotateSecret(activeSeller.id, endpoint.id)).rejects.toMatchObject({
      code: "SELLER_SUSPENDED"
    });
    // Deletion is recovery: it stays available while suspended.
    await expect(
      gated.deleteWebhookEndpoint(activeSeller.id, endpoint.id)
    ).resolves.toBeUndefined();
  });

  it("excludes suspended sellers' resources from discovery and search", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(testConfig(), sellerService);
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    const resource = await resourceService.createResource(resourceInput(seller.id));
    const resolver: SellerStatusResolver = (sellerId) => sellerService.getSellerStatus(sellerId);
    const discovery = new DiscoveryService(resourceService, resolver);
    const search = new SearchService(resourceService, undefined, undefined, resolver);

    await expect(discovery.browse({})).resolves.toMatchObject({
      resources: [expect.objectContaining({ id: resource.id })]
    });
    await expect(search.search({ q: "weather" })).resolves.toMatchObject({
      resources: [expect.objectContaining({ id: resource.id })]
    });

    await sellerService.suspendSeller(seller.id, "operator review");

    await expect(discovery.browse({})).resolves.toMatchObject({ resources: [] });
    await expect(search.search({ q: "weather" })).resolves.toMatchObject({ resources: [] });
    // Single-resource reads are unaffected by the discovery filter.
    await expect(resourceService.getResource(resource.id)).resolves.toMatchObject({
      id: resource.id
    });
  });
});
