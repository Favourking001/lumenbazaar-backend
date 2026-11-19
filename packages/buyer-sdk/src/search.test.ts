import { afterEach, describe, expect, it, vi } from "vitest";

import { maxSearchQueryTerms } from "@lumenbazaar/shared";

import { searchByName, searchResources } from "./search.js";

const apiUrl = "https://api.example.test";

function stubFetch() {
  const fetchImpl = vi.fn(async (_url: string) =>
    Response.json({
      resources: [],
      ranking: { strategy: "postgres-full-text-v1" },
      partialResults: false,
      nextCursor: null
    })
  );
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

describe("buyer SDK search limits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a valid search without modification", async () => {
    const fetchImpl = stubFetch();

    await expect(searchResources(apiUrl, { q: "weather", limit: 20 })).resolves.toMatchObject({
      resources: [],
      partialResults: false,
      nextCursor: null
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/v1/discovery/search?");
  });

  it("rejects a page size above the maximum before fetching", async () => {
    const fetchImpl = stubFetch();

    await expect(searchResources(apiUrl, { q: "weather", limit: 101 })).rejects.toMatchObject({
      code: "PAGE_SIZE_EXCEEDED"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an adversarial query before fetching", async () => {
    const fetchImpl = stubFetch();
    const q = Array.from({ length: maxSearchQueryTerms }, (_, i) => `term${i}`).join(" ");

    await expect(
      searchResources(apiUrl, {
        q,
        network: "stellar:testnet",
        asset: "USDC",
        type: "http",
        sellerId: "seller_1",
        limit: 100
      })
    ).rejects.toMatchObject({ code: "QUERY_TOO_COMPLEX" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a query with too many terms before fetching", async () => {
    const fetchImpl = stubFetch();
    const q = Array.from({ length: maxSearchQueryTerms + 1 }, (_, i) => `term${i}`).join(" ");

    await expect(searchResources(apiUrl, { q })).rejects.toMatchObject({
      code: "QUERY_TOO_COMPLEX"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the convenience helpers inside the budget", async () => {
    const fetchImpl = stubFetch();

    await searchByName(apiUrl, "weather");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces the API's actionable error when the server rejects a query", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "QUERY_TOO_COMPLEX",
              message: "Search query cost 59 exceeds the maximum budget of 50."
            }
          }),
          { status: 422, statusText: "Unprocessable Entity" }
        )
    );
    vi.stubGlobal("fetch", fetchImpl);

    await expect(searchResources(apiUrl, { q: "weather" })).rejects.toThrow(
      "QUERY_TOO_COMPLEX: Search query cost 59 exceeds the maximum budget of 50."
    );
  });
});
