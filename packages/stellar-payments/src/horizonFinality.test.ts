/**
 * Tests for the Horizon pagination exhaustion guard.
 *
 * Every Horizon response is stubbed deterministically: no live network,
 * no real account data. Page fixtures use synthetic record ids and
 * synthetic Horizon-style `next` URLs.
 */

import { describe, expect, it, vi } from "vitest";
import { type AppConfig } from "@lumenbazaar/shared";

import {
  DEFAULT_HORIZON_TRAVERSAL_BUDGET,
  buildHorizonHistoryUrl,
  fetchHorizonHistoryPage,
  resolveHorizonTraversalBudget,
  traverseHorizonHistory,
  type HorizonPage
} from "./horizonFinality.js";

type RecordFixture = { id: string };

function record(id: string): RecordFixture {
  return { id };
}

function page(records: RecordFixture[], nextUrl?: string): HorizonPage<RecordFixture> {
  return { records, ...(nextUrl === undefined ? {} : { nextUrl }) };
}

/** Stub fetcher serving pages from a URL -> page map, recording every fetch. */
function stubFetcher(pages: Record<string, HorizonPage<RecordFixture>>) {
  const fetchedUrls: string[] = [];
  const fetchPage = vi.fn(async (url: string) => {
    fetchedUrls.push(url);
    const found = pages[url];
    if (found === undefined) {
      throw new Error(`Unexpected Horizon URL in stub: ${url}`);
    }
    return found;
  });
  return { fetchPage, fetchedUrls };
}

function testConfig(horizonTraversal: {
  maxPages: number;
  maxRecords: number;
  maxDurationMs: number;
}): AppConfig {
  return {
    settlement: {
      maxTransactionFeeStroops: 50_000,
      inclusionFeeStroops: 100,
      feeCeilingStroops: 50_000,
      feeCeilingOverrideEnabled: false,
      horizonTraversal
    }
  } as AppConfig;
}

describe("resolveHorizonTraversalBudget", () => {
  it("returns the documented defaults with no config or overrides", () => {
    expect(resolveHorizonTraversalBudget()).toEqual({
      maxPages: 100,
      maxRecords: 1000,
      maxDurationMs: 30_000,
      pageSize: 100
    });
    expect(DEFAULT_HORIZON_TRAVERSAL_BUDGET).toEqual({
      maxPages: 100,
      maxRecords: 1000,
      maxDurationMs: 30_000,
      pageSize: 100
    });
  });

  it("reads budgets from deployment config", () => {
    const budget = resolveHorizonTraversalBudget(
      testConfig({ maxPages: 5, maxRecords: 50, maxDurationMs: 5_000 })
    );
    expect(budget).toEqual({ maxPages: 5, maxRecords: 50, maxDurationMs: 5_000, pageSize: 100 });
  });

  it("lets per-call overrides win over config and defaults", () => {
    const budget = resolveHorizonTraversalBudget(
      testConfig({ maxPages: 5, maxRecords: 50, maxDurationMs: 5_000 }),
      { maxPages: 2 }
    );
    expect(budget.maxPages).toBe(2);
    expect(budget.maxRecords).toBe(50);
    expect(budget.maxDurationMs).toBe(5_000);
  });

  it.each([
    [{ maxPages: 0 }, "maxPages"],
    [{ maxRecords: -1 }, "maxRecords"],
    [{ maxDurationMs: 1.5 }, "maxDurationMs"],
    [{ pageSize: 201 }, "pageSize"],
    [{ maxPages: 10_001 }, "maxPages"]
  ])("fails closed for an invalid budget %s", (overrides) => {
    expect(() => resolveHorizonTraversalBudget(undefined, overrides)).toThrow(
      /Horizon traversal budget/
    );
  });
});

describe("traverseHorizonHistory", () => {
  it("traverses linked pages to completion", async () => {
    const { fetchPage, fetchedUrls } = stubFetcher({
      "https://horizon.test/page1": page([record("a"), record("b")], "https://horizon.test/page2"),
      "https://horizon.test/page2": page([record("c")])
    });
    const progress: number[] = [];
    const result = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage,
      onProgress: (metrics) => {
        progress.push(metrics.pagesFetched);
      }
    });

    expect(result.completed).toBe(true);
    expect(result.exhaustedReason).toBeUndefined();
    expect(result.resumeCursor).toBeUndefined();
    expect(result.records.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(result.pagesFetched).toBe(2);
    expect(result.recordsFetched).toBe(3);
    expect(fetchedUrls).toEqual(["https://horizon.test/page1", "https://horizon.test/page2"]);
    expect(result.metrics.completed).toBe(true);
    expect(progress.at(-1)).toBe(2);
  });

  it("terminates on a cyclic next link and resumes without re-fetching", async () => {
    const { fetchPage, fetchedUrls } = stubFetcher({
      "https://horizon.test/page1": page([record("a")], "https://horizon.test/page2"),
      "https://horizon.test/page2": page([record("b")], "https://horizon.test/page1")
    });
    const result = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage
    });

    expect(result.completed).toBe(false);
    expect(result.exhaustedReason).toBe("cyclic_next_link");
    expect(result.records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.pagesFetched).toBe(2);
    expect(result.resumeCursor).toBeDefined();
    expect(result.resumeCursor?.nextUrl).toBe("https://horizon.test/page1");

    // Resuming from the cyclic cursor must terminate immediately: the
    // cycle is re-detected before any further fetch, and no record repeats.
    const resumed = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage,
      resumeCursor: result.resumeCursor
    });
    expect(resumed.completed).toBe(false);
    expect(resumed.exhaustedReason).toBe("cyclic_next_link");
    expect(resumed.records).toEqual([]);
    expect(fetchedUrls).toHaveLength(2);
  });

  it("terminates on a self-referencing next link", async () => {
    const { fetchPage } = stubFetcher({
      "https://horizon.test/page1": page([record("a")], "https://horizon.test/page1")
    });
    const result = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage
    });
    expect(result.completed).toBe(false);
    expect(result.exhaustedReason).toBe("cyclic_next_link");
    expect(result.pagesFetched).toBe(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("continues through empty pages and completes on an empty final page", async () => {
    const { fetchPage, fetchedUrls } = stubFetcher({
      "https://horizon.test/page1": page([], "https://horizon.test/page2"),
      "https://horizon.test/page2": page([record("a")], "https://horizon.test/page3"),
      "https://horizon.test/page3": page([])
    });
    const result = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage
    });

    expect(result.completed).toBe(true);
    expect(result.records.map((r) => r.id)).toEqual(["a"]);
    expect(result.pagesFetched).toBe(3);
    expect(result.metrics.emptyPages).toBe(2);
    expect(fetchedUrls).toHaveLength(3);
  });

  it("stops cleanly when the page budget is exhausted and resumes from the cursor", async () => {
    const pages: Record<string, HorizonPage<RecordFixture>> = {};
    for (let i = 1; i <= 5; i += 1) {
      pages[`https://horizon.test/page${i}`] = page(
        [record(`r${i}`)],
        i < 5 ? `https://horizon.test/page${i + 1}` : undefined
      );
    }
    const { fetchPage, fetchedUrls } = stubFetcher(pages);

    const first = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage,
      budget: { maxPages: 2 }
    });
    expect(first.completed).toBe(false);
    expect(first.exhaustedReason).toBe("page_budget");
    expect(first.records.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(first.resumeCursor?.nextUrl).toBe("https://horizon.test/page3");

    const resumed = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage,
      budget: { maxPages: 10 },
      resumeCursor: first.resumeCursor
    });
    expect(resumed.completed).toBe(true);
    expect(resumed.records.map((r) => r.id)).toEqual(["r3", "r4", "r5"]);
    expect(resumed.pagesFetched).toBe(5);
    expect(fetchedUrls).toEqual([
      "https://horizon.test/page1",
      "https://horizon.test/page2",
      "https://horizon.test/page3",
      "https://horizon.test/page4",
      "https://horizon.test/page5"
    ]);
  });

  it("stops cleanly when the record budget is exhausted without losing the resume point", async () => {
    const { fetchPage } = stubFetcher({
      "https://horizon.test/page1": page(
        [record("a"), record("b"), record("c")],
        "https://horizon.test/page2"
      ),
      "https://horizon.test/page2": page([record("d")])
    });
    const result = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage,
      budget: { maxRecords: 2 }
    });

    expect(result.completed).toBe(false);
    expect(result.exhaustedReason).toBe("record_budget");
    expect(result.records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.resumeCursor?.nextUrl).toBe("https://horizon.test/page2");
    expect(fetchPage).toHaveBeenCalledTimes(1);

    const resumed = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage,
      budget: { maxRecords: 10 },
      resumeCursor: result.resumeCursor
    });
    expect(resumed.completed).toBe(true);
    expect(resumed.records.map((r) => r.id)).toEqual(["d"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("stops cleanly when the duration budget is exhausted and resumes afterwards", async () => {
    let clock = 0;
    const { fetchPage } = stubFetcher({
      "https://horizon.test/page1": page([record("a")], "https://horizon.test/page2"),
      "https://horizon.test/page2": page([record("b")], "https://horizon.test/page3"),
      "https://horizon.test/page3": page([record("c")])
    });
    const advancingFetch: typeof fetchPage = async (url) => {
      const result = await fetchPage(url);
      clock += 100;
      return result;
    };
    const first = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage: advancingFetch,
      budget: { maxDurationMs: 150 },
      now: () => clock
    });

    expect(first.completed).toBe(false);
    expect(first.exhaustedReason).toBe("duration_budget");
    expect(first.records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(first.resumeCursor?.nextUrl).toBe("https://horizon.test/page3");
    expect(fetchPage).toHaveBeenCalledTimes(2);

    const resumed = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage,
      budget: { maxDurationMs: 10_000 },
      resumeCursor: first.resumeCursor,
      now: () => clock
    });
    expect(resumed.completed).toBe(true);
    expect(resumed.records.map((r) => r.id)).toEqual(["c"]);
  });

  it("skips duplicate records across pages and across resumes without counting them twice", async () => {
    const { fetchPage } = stubFetcher({
      "https://horizon.test/page1": page([record("a"), record("b")], "https://horizon.test/page2"),
      "https://horizon.test/page2": page([record("b"), record("c")], "https://horizon.test/page3"),
      "https://horizon.test/page3": page([record("a"), record("d")])
    });
    const result = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage,
      budget: { maxPages: 2 }
    });
    expect(result.records.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(result.metrics.duplicateRecordsSkipped).toBe(1);

    const resumed = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage,
      budget: { maxPages: 10 },
      resumeCursor: result.resumeCursor
    });
    expect(resumed.records.map((r) => r.id)).toEqual(["d"]);
    expect(resumed.metrics.duplicateRecordsSkipped).toBe(1);
  });

  it("stops an endless stream of empty pages at the page budget", async () => {
    const fetchPage = vi.fn(async (url: string) => {
      const next = `https://horizon.test/empty-${Number(url.split("-").at(-1) ?? "0") + 1}`;
      return page([], next);
    });
    const result = await traverseHorizonHistory({
      startUrl: "https://horizon.test/empty-0",
      fetchPage,
      budget: { maxPages: 3 }
    });
    expect(result.completed).toBe(false);
    expect(result.exhaustedReason).toBe("page_budget");
    expect(result.records).toEqual([]);
    expect(result.metrics.emptyPages).toBe(3);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("fails closed on a malformed page", async () => {
    const fetchPage = vi.fn(
      async () => ({ records: "not-an-array" }) as unknown as HorizonPage<RecordFixture>
    );
    await expect(
      traverseHorizonHistory({ startUrl: "https://horizon.test/page1", fetchPage })
    ).rejects.toThrow(/malformed history page/);
  });

  it("reports observable metrics through onProgress and the result", async () => {
    const seen: Array<{ pagesFetched: number; recordsFetched: number; completed: boolean }> = [];
    const { fetchPage } = stubFetcher({
      "https://horizon.test/page1": page([record("a")], "https://horizon.test/page2"),
      "https://horizon.test/page2": page([record("b")])
    });
    const result = await traverseHorizonHistory({
      startUrl: "https://horizon.test/page1",
      fetchPage,
      onProgress: (metrics) => {
        seen.push({
          pagesFetched: metrics.pagesFetched,
          recordsFetched: metrics.recordsFetched,
          completed: metrics.completed
        });
      }
    });
    expect(result.metrics).toMatchObject({
      pagesFetched: 2,
      recordsFetched: 2,
      duplicateRecordsSkipped: 0,
      emptyPages: 0,
      completed: true
    });
    expect(seen.at(-1)).toMatchObject({ pagesFetched: 2, recordsFetched: 2, completed: true });
  });
});

describe("buildHorizonHistoryUrl", () => {
  it("builds a first-page Horizon collection URL with limit and order", () => {
    expect(
      buildHorizonHistoryUrl("https://horizon-testnet.stellar.org/", "/accounts/ABC/transactions", {
        pageSize: 50,
        cursor: "123"
      })
    ).toBe(
      "https://horizon-testnet.stellar.org/accounts/ABC/transactions?limit=50&order=asc&cursor=123"
    );
  });
});

describe("fetchHorizonHistoryPage", () => {
  const horizonBody = {
    _embedded: { records: [{ id: "a" }, { id: "b" }] },
    _links: { next: { href: "https://horizon.test/page2" } }
  };

  it("parses records and the next link from a Horizon response", async () => {
    const fetchFn = vi.fn(async () => Response.json(horizonBody)) as unknown as typeof fetch;
    const result = await fetchHorizonHistoryPage<RecordFixture>("https://horizon.test/page1", {
      fetchFn
    });
    expect(result.records).toEqual([{ id: "a" }, { id: "b" }]);
    expect(result.nextUrl).toBe("https://horizon.test/page2");
  });

  it("fails closed on a non-2xx response", async () => {
    const fetchFn = vi.fn(
      async () => new Response("error", { status: 503 })
    ) as unknown as typeof fetch;
    await expect(
      fetchHorizonHistoryPage("https://horizon.test/page1", { fetchFn })
    ).rejects.toThrow(/HTTP 503/);
  });

  it("fails closed on a malformed body", async () => {
    const fetchFn = vi.fn(async () => Response.json({ _embedded: {} })) as unknown as typeof fetch;
    await expect(
      fetchHorizonHistoryPage("https://horizon.test/page1", { fetchFn })
    ).rejects.toThrow(/malformed history page/);
  });
});
