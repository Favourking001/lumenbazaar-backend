import { describe, expect, it } from "vitest";

import {
  assertSearchQueryWithinLimits,
  estimateSearchQueryCost,
  maxSearchCost,
  maxSearchQueryLength,
  maxSearchQueryTerms
} from "./searchLimits.js";
import { maxPageLimit } from "./pagination.js";

describe("search query cost model", () => {
  it("is deterministic: the same query always costs the same", () => {
    const input = {
      q: "weather forecast",
      network: "stellar:testnet",
      type: "http",
      limit: 20
    };

    expect(estimateSearchQueryCost(input)).toEqual(estimateSearchQueryCost(input));
    expect(estimateSearchQueryCost(input)).toMatchObject({
      // base 1 + 2 terms * 2 + 2 filters * 2 + ceil(20 / 10) * 1 = 11
      cost: 11,
      maxCost: maxSearchCost,
      termCount: 2,
      filterCount: 2,
      limit: 20,
      breakdown: { base: 1, queryTerms: 4, filters: 4, pageSize: 2 }
    });
  });

  it("charges nothing for an empty query with default pagination", () => {
    expect(estimateSearchQueryCost({})).toMatchObject({
      cost: 4, // base 1 + ceil(25 / 10) * 1
      termCount: 0,
      filterCount: 0,
      limit: 25
    });
  });

  it("accepts the largest valid page size", () => {
    const estimate = assertSearchQueryWithinLimits({ limit: maxPageLimit });

    expect(estimate.limit).toBe(maxPageLimit);
    expect(estimate.cost).toBeLessThanOrEqual(maxSearchCost);
  });

  it("rejects a page size above the maximum with an actionable error", () => {
    try {
      assertSearchQueryWithinLimits({ limit: 101 });
      expect.unreachable("expected PAGE_SIZE_EXCEEDED");
    } catch (error) {
      expect(error).toMatchObject({
        name: "LumenError",
        code: "PAGE_SIZE_EXCEEDED",
        statusCode: 400
      });
      expect((error as Error).message).toContain("maximum page size of 100");
      expect((error as { details?: unknown }).details).toEqual({
        requestedLimit: 101,
        maxPageLimit: 100
      });
    }
  });

  it("rejects an over-long query before scoring it", () => {
    const q = "a".repeat(maxSearchQueryLength + 1);

    expect(() => assertSearchQueryWithinLimits({ q })).toThrowError(/maximum of 200/);
    try {
      assertSearchQueryWithinLimits({ q });
      expect.unreachable("expected QUERY_TOO_COMPLEX");
    } catch (error) {
      expect(error).toMatchObject({ code: "QUERY_TOO_COMPLEX", statusCode: 422 });
    }
  });

  it("rejects a query with too many terms", () => {
    const q = Array.from({ length: maxSearchQueryTerms + 1 }, (_, i) => `term${i}`).join(" ");

    try {
      assertSearchQueryWithinLimits({ q });
      expect.unreachable("expected QUERY_TOO_COMPLEX");
    } catch (error) {
      expect(error).toMatchObject({ code: "QUERY_TOO_COMPLEX", statusCode: 422 });
      expect((error as Error).message).toContain(`maximum of ${maxSearchQueryTerms}`);
      expect((error as { details?: { termCount?: number } }).details?.termCount).toBe(
        maxSearchQueryTerms + 1
      );
    }
  });

  it("rejects an adversarial query: maximum terms, all filters, maximum page", () => {
    const q = Array.from({ length: maxSearchQueryTerms }, (_, i) => `term${i}`).join(" ");

    try {
      assertSearchQueryWithinLimits({
        q,
        network: "stellar:testnet",
        asset: "USDC",
        type: "http",
        sellerId: "seller_1",
        limit: 100
      });
      expect.unreachable("expected QUERY_TOO_COMPLEX");
    } catch (error) {
      expect(error).toMatchObject({ code: "QUERY_TOO_COMPLEX", statusCode: 422 });
      // base 1 + 20 terms * 2 + 4 filters * 2 + ceil(100 / 10) * 1 = 59 > 50
      expect((error as { details?: { cost?: number } }).details?.cost).toBe(59);
      expect((error as Error).message).toContain("exceeds the maximum budget of 50");
    }
  });

  it("accepts ordinary SDK-style queries well inside the budget", () => {
    expect(assertSearchQueryWithinLimits({ q: "weather", limit: 20 }).cost).toBe(5);
    expect(assertSearchQueryWithinLimits({ network: "stellar:testnet", limit: 50 }).cost).toBe(8);
    expect(assertSearchQueryWithinLimits({ type: "mcp", q: "tools", limit: 30 }).cost).toBe(8);
  });
});
