import { LumenError } from "./errors.js";
import { defaultPageLimit, maxPageLimit } from "./pagination.js";

/**
 * Deterministic cost model for discovery search and browse queries.
 *
 * A query is scored before any database work runs, so an expensive or
 * oversized request is rejected with an actionable error instead of
 * consuming a scan and returning a truncated page.
 *
 * Cost table (see docs/api/search-query-limits.md):
 * - base cost: 1 per query
 * - each free-text query term: 2
 * - each active filter (network, asset, type, sellerId, minPrice,
 *   maxPrice, extension): 2
 * - each block of up to 10 requested results: 1
 *
 * Caps:
 * - maximum query cost: 50
 * - maximum free-text query terms: 20
 * - maximum free-text query length: 200 characters
 * - maximum page size: 100 (shared maxPageLimit)
 * - maximum candidates scored per search: 100
 */
export const searchBaseCost = 1;
export const searchCostPerQueryTerm = 2;
export const searchCostPerFilter = 2;
export const searchCostPerPageBlock = 1;
export const searchPageBlockSize = 10;
export const maxSearchCost = 50;
export const maxSearchQueryTerms = 20;
export const maxSearchQueryLength = 200;
export const maxSearchCandidates = 100;

export type SearchQueryCostInput = {
  q?: string | undefined;
  network?: string | undefined;
  asset?: string | undefined;
  type?: string | undefined;
  sellerId?: string | undefined;
  minPrice?: string | undefined;
  maxPrice?: string | undefined;
  extension?: string | undefined;
  limit?: number | undefined;
};

export type SearchQueryCostBreakdown = {
  base: number;
  queryTerms: number;
  filters: number;
  pageSize: number;
};

export type SearchQueryCost = {
  cost: number;
  maxCost: number;
  termCount: number;
  filterCount: number;
  limit: number;
  breakdown: SearchQueryCostBreakdown;
};

/** Split a free-text query into lowercase alphanumeric terms. */
export function tokenizeSearchQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
}

export function countSearchQueryTerms(query: string | undefined): number {
  if (query === undefined || query.length === 0) {
    return 0;
  }

  return tokenizeSearchQuery(query).length;
}

function countActiveFilters(input: SearchQueryCostInput): number {
  return [
    input.network,
    input.asset,
    input.type,
    input.sellerId,
    input.minPrice,
    input.maxPrice,
    input.extension
  ].filter((value) => value !== undefined).length;
}

function effectiveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return defaultPageLimit;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), maxPageLimit);
}

/**
 * Score a discovery query deterministically. Pure function: the same input
 * always produces the same cost, independent of database state.
 */
export function estimateSearchQueryCost(input: SearchQueryCostInput): SearchQueryCost {
  const termCount = countSearchQueryTerms(input.q);
  const filterCount = countActiveFilters(input);
  const limit = effectiveLimit(input.limit);
  const breakdown: SearchQueryCostBreakdown = {
    base: searchBaseCost,
    queryTerms: termCount * searchCostPerQueryTerm,
    filters: filterCount * searchCostPerFilter,
    pageSize: Math.ceil(limit / searchPageBlockSize) * searchCostPerPageBlock
  };

  return {
    cost: breakdown.base + breakdown.queryTerms + breakdown.filters + breakdown.pageSize,
    maxCost: maxSearchCost,
    termCount,
    filterCount,
    limit,
    breakdown
  };
}

/**
 * Enforce the search query caps before any expensive execution. Throws a
 * LumenError with an actionable code, message, and details when the query
 * exceeds a cap; otherwise returns the deterministic cost estimate.
 */
export function assertSearchQueryWithinLimits(input: SearchQueryCostInput): SearchQueryCost {
  if (
    input.limit !== undefined &&
    Number.isFinite(input.limit) &&
    Math.trunc(input.limit) > maxPageLimit
  ) {
    throw new LumenError(
      "PAGE_SIZE_EXCEEDED",
      `Requested page size ${Math.trunc(input.limit)} exceeds the maximum page size of ${maxPageLimit}. Reduce limit to ${maxPageLimit} or less.`,
      {
        details: {
          requestedLimit: Math.trunc(input.limit),
          maxPageLimit
        }
      }
    );
  }

  if (input.q !== undefined && input.q.length > maxSearchQueryLength) {
    throw new LumenError(
      "QUERY_TOO_COMPLEX",
      `Search query is ${input.q.length} characters, over the maximum of ${maxSearchQueryLength}. Shorten the query.`,
      {
        details: {
          queryLength: input.q.length,
          maxQueryLength: maxSearchQueryLength
        }
      }
    );
  }

  const estimate = estimateSearchQueryCost(input);

  if (estimate.termCount > maxSearchQueryTerms) {
    throw new LumenError(
      "QUERY_TOO_COMPLEX",
      `Search query has ${estimate.termCount} terms, over the maximum of ${maxSearchQueryTerms}. Use fewer search terms.`,
      {
        details: {
          termCount: estimate.termCount,
          maxQueryTerms: maxSearchQueryTerms,
          cost: estimate.cost,
          maxCost: estimate.maxCost
        }
      }
    );
  }

  if (estimate.cost > estimate.maxCost) {
    throw new LumenError(
      "QUERY_TOO_COMPLEX",
      `Search query cost ${estimate.cost} exceeds the maximum budget of ${estimate.maxCost}. Remove filters, shorten the query, or request fewer results per page.`,
      {
        details: {
          cost: estimate.cost,
          maxCost: estimate.maxCost,
          termCount: estimate.termCount,
          filterCount: estimate.filterCount,
          limit: estimate.limit,
          breakdown: estimate.breakdown
        }
      }
    );
  }

  return estimate;
}
