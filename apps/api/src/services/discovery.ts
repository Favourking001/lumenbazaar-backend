import { z } from "zod";

import {
  type Resource,
  assertSearchQueryWithinLimits,
  type SellerStatusResolver
} from "@lumenbazaar/shared";

import { type ResourceService } from "./resources.js";

export const browseDiscoverySchema = z.object({
  network: z.enum(["stellar:testnet", "stellar:pubnet"]).optional(),
  asset: z.string().optional(),
  type: z.enum(["http", "mcp"]).optional(),
  sellerId: z.string().optional(),
  minPrice: z.string().optional(),
  maxPrice: z.string().optional(),
  extension: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().optional()
});

export type DiscoveryBrowseResult = {
  resources: Resource[];
  nextCursor: string | null;
  partialResults: false;
};

export class DiscoveryService {
  constructor(
    private readonly resourceService: ResourceService,
    /**
     * Optional seller-status resolver. When provided, resources owned by
     * suspended sellers are excluded from browse results so a suspended
     * seller cannot be reached for a new paid call through discovery.
     * Single-resource reads are unaffected.
     */
    private readonly resolveSellerStatus?: SellerStatusResolver
  ) {}

  async browse(input: unknown): Promise<DiscoveryBrowseResult> {
    const filters = browseDiscoverySchema.parse(input);
    // Enforce query cost and result caps before any database work.
    assertSearchQueryWithinLimits(filters);
    const page = await this.resourceService.listResources({
      ...filters,
      status: "active"
    });

    return {
      resources: await this.filterSuspendedSellersResources(page.resources),
      nextCursor: page.nextCursor,
      partialResults: false
    };
  }

  private async filterSuspendedSellersResources(resources: Resource[]): Promise<Resource[]> {
    if (this.resolveSellerStatus === undefined) {
      return resources;
    }
    const sellerIds = [...new Set(resources.map((resource) => resource.sellerId))];
    const suspended = new Set(
      (
        await Promise.all(
          sellerIds.map(async (sellerId) => {
            const info = await this.resolveSellerStatus!(sellerId);
            return info?.status === "suspended" ? sellerId : null;
          })
        )
      ).filter((sellerId): sellerId is string => sellerId !== null)
    );
    return resources.filter((resource) => !suspended.has(resource.sellerId));
  }
}
