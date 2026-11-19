import { describe, expect, it } from "vitest";

import {
  applyMcpResponsePolicy,
  budgetForTool,
  chunkJsonText,
  decodeTruncationCursor,
  defaultMcpResponsePolicy,
  encodeTruncationCursor,
  extractPaymentEvidence,
  hasPaymentEvidence,
  jsonByteSize,
  McpResponseArtifactStore,
  McpResponseEvidenceTooLargeError,
  resolveMcpResponsePolicy,
  serializeTruncatedJsonStream,
  streamJsonChunks
} from "./mcpResponsePolicy.js";

function bigResources(count: number, descriptionLength: number) {
  return {
    resources: Array.from({ length: count }, (_value, index) => ({
      id: `resource_${index}`,
      name: `Resource ${index}`,
      description: "x".repeat(descriptionLength),
      type: "http",
      url: `https://example.test/resource/${index}`,
      paymentTerms: {
        scheme: "exact",
        network: "stellar:testnet",
        asset: "USDC",
        amount: "200000",
        payTo: "GBZXN7PIRZGNMHGAIQW7QEJWW36L5CVVNRYANMDW2G3QOF2VCR4DQSQE",
        maxTimeoutSeconds: 60,
        extra: { assetCode: "USDC" }
      }
    })),
    total: count
  };
}

describe("MCP response budgets", () => {
  it("uses per-tool defaults and falls back to the default budget", () => {
    expect(budgetForTool(defaultMcpResponsePolicy, "search_paid_resources")).toBe(128 * 1024);
    expect(budgetForTool(defaultMcpResponsePolicy, "call_paid_resource")).toBe(256 * 1024);
    expect(budgetForTool(defaultMcpResponsePolicy, "list_supported_networks")).toBe(16 * 1024);
    expect(budgetForTool(defaultMcpResponsePolicy, "unknown_tool")).toBe(64 * 1024);
  });

  it("resolves per-tool and global overrides from the environment", () => {
    const policy = resolveMcpResponsePolicy({
      MCP_RESPONSE_MAX_BYTES: "2048",
      MCP_RESPONSE_MAX_BYTES_SEARCH_PAID_RESOURCES: "4096",
      MCP_RESPONSE_MAX_BYTES_CALL_PAID_RESOURCE: "not-a-number",
      MCP_RESPONSE_CHUNK_BYTES: "512"
    });
    expect(policy.defaultBudgetBytes).toBe(2048);
    expect(budgetForTool(policy, "search_paid_resources")).toBe(4096);
    expect(budgetForTool(policy, "call_paid_resource")).toBe(256 * 1024);
    expect(policy.chunkBytes).toBe(512);
  });

  it("ignores non-positive environment values", () => {
    const policy = resolveMcpResponsePolicy({ MCP_RESPONSE_MAX_BYTES: "0" });
    expect(policy.defaultBudgetBytes).toBe(64 * 1024);
  });
});

describe("applyMcpResponsePolicy (JSON responses)", () => {
  it("returns just-under-budget results unchanged", () => {
    const value = { data: "x".repeat(100) };
    const budget = jsonByteSize(value) + 1;
    const policy = { ...defaultMcpResponsePolicy, defaultBudgetBytes: budget };
    const result = applyMcpResponsePolicy(value, { tool: "unknown_tool", policy });
    expect(result.truncated).toBe(false);
    expect(result.truncation).toBeUndefined();
    expect(result.value).toEqual(value);
  });

  it("returns at-budget results unchanged", () => {
    const value = { data: "x".repeat(100) };
    const budget = jsonByteSize(value);
    const policy = { ...defaultMcpResponsePolicy, defaultBudgetBytes: budget };
    const result = applyMcpResponsePolicy(value, { tool: "unknown_tool", policy });
    expect(result.truncated).toBe(false);
    expect(result.value).toEqual(value);
  });

  it("truncates just-over-budget results explicitly with byte accounting", () => {
    const value = { data: "x".repeat(2000) };
    const budget = jsonByteSize(value) - 1;
    const policy = { ...defaultMcpResponsePolicy, defaultBudgetBytes: budget };
    const result = applyMcpResponsePolicy(value, { tool: "unknown_tool", policy });
    expect(result.truncated).toBe(true);
    expect(result.truncation).toMatchObject({
      truncated: true,
      tool: "unknown_tool",
      budgetBytes: budget,
      originalBytes: jsonByteSize(value),
      reason: "response_exceeds_budget"
    });
    expect(result.truncation?.truncatedBytes).toBe(jsonByteSize(result.value));
    expect(jsonByteSize(result.value)).toBeLessThanOrEqual(budget);
  });

  it("keeps an array prefix and reports omitted items for large search results", () => {
    const value = bigResources(20, 200);
    const store = new McpResponseArtifactStore();
    const policy = {
      ...defaultMcpResponsePolicy,
      budgets: { ...defaultMcpResponsePolicy.budgets, search_paid_resources: 2048 }
    };
    const result = applyMcpResponsePolicy(value, {
      tool: "search_paid_resources",
      policy,
      artifacts: store
    });
    expect(result.truncated).toBe(true);
    const resources = result.value.resources as Array<unknown>;
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.length).toBeLessThan(20);
    expect(result.truncation?.omittedItems).toBe(20 - resources.length);
    expect(result.truncation?.omittedBytes).toBeGreaterThan(0);
    expect(result.truncation?.artifactId).toBeDefined();
    expect(result.truncation?.cursor).toBeDefined();
    expect(jsonByteSize(result.value)).toBeLessThanOrEqual(2048);
    // The artifact holds the omitted remainder for retrieval.
    const artifact = store.get(result.truncation?.artifactId as string);
    expect(artifact?.omitted.length).toBeGreaterThan(0);
    expect(artifact?.tool).toBe("search_paid_resources");
  });

  it("truncates oversized strings without dropping sibling fields", () => {
    const value = { title: "short", body: "y".repeat(5000), count: 3 };
    const policy = { ...defaultMcpResponsePolicy, defaultBudgetBytes: 1024 };
    const result = applyMcpResponsePolicy(value, { tool: "unknown_tool", policy });
    expect(result.truncated).toBe(true);
    expect(result.value.title).toBe("short");
    expect(result.value.count).toBe(3);
    expect((result.value.body as string).length).toBeLessThan(5000);
    expect(jsonByteSize(result.value)).toBeLessThanOrEqual(1024);
  });

  it("drops whole non-evidence fields when arrays and strings cannot fit", () => {
    const value = {
      keep: "small",
      blobA: { nested: "a".repeat(2000) },
      blobB: { nested: "b".repeat(2000) }
    };
    const policy = { ...defaultMcpResponsePolicy, defaultBudgetBytes: 1024 };
    const result = applyMcpResponsePolicy(value, { tool: "unknown_tool", policy });
    expect(result.truncated).toBe(true);
    expect(result.value.keep).toBe("small");
    expect(result.truncation?.droppedFields.length).toBeGreaterThan(0);
    expect(jsonByteSize(result.value)).toBeLessThanOrEqual(1024);
  });
});

describe("payment evidence preservation", () => {
  const receiptResult = {
    receipt: {
      id: "receipt_1",
      correlationId: "corr-testnet-001",
      transactionHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      ledger: 123456,
      network: "stellar:testnet",
      amount: "200000",
      assetCode: "USDC",
      status: "settled"
    },
    // Large non-evidence payload that must give way to the receipt.
    debug: "z".repeat(8000),
    notes: Array.from({ length: 30 }, (_v, i) => `note ${i} ` + "n".repeat(100))
  };

  it("detects and extracts payment evidence", () => {
    expect(hasPaymentEvidence(receiptResult)).toBe(true);
    expect(hasPaymentEvidence({ data: "plain" })).toBe(false);
    const evidence = extractPaymentEvidence(receiptResult) as Record<string, unknown>;
    expect(evidence.receipt).toEqual(receiptResult.receipt);
    expect(evidence.debug).toBeUndefined();
  });

  it("preserves the full receipt verbatim when truncating around it", () => {
    const policy = {
      ...defaultMcpResponsePolicy,
      budgets: { ...defaultMcpResponsePolicy.budgets, get_payment_receipt: 2048 }
    };
    const result = applyMcpResponsePolicy(receiptResult, {
      tool: "get_payment_receipt",
      policy
    });
    expect(result.truncated).toBe(true);
    expect(result.value.receipt).toEqual(receiptResult.receipt);
    expect(jsonByteSize(result.value)).toBeLessThanOrEqual(2048);
  });

  it("fails explicitly instead of dropping evidence that alone exceeds the budget", () => {
    const policy = {
      ...defaultMcpResponsePolicy,
      budgets: { ...defaultMcpResponsePolicy.budgets, get_payment_receipt: 1024 }
    };
    const oversizedEvidence = {
      receipt: {
        id: "receipt_1",
        correlationId: "corr-testnet-001",
        transactionHash: "a".repeat(2000),
        evidenceHash: "b".repeat(2000),
        ledger: 123456,
        network: "stellar:testnet",
        amount: "200000",
        assetCode: "USDC",
        status: "settled"
      }
    };
    expect(() =>
      applyMcpResponsePolicy(oversizedEvidence, { tool: "get_payment_receipt", policy })
    ).toThrow(McpResponseEvidenceTooLargeError);
    expect(() =>
      applyMcpResponsePolicy(oversizedEvidence, { tool: "get_payment_receipt", policy })
    ).toThrow(/exceeds the get_payment_receipt response budget/);
  });
});

describe("truncation cursors and the artifact store", () => {
  it("round-trips a cursor and rejects malformed cursors", () => {
    const cursor = encodeTruncationCursor({
      artifactId: "art-1",
      tool: "search_paid_resources",
      offset: 7
    });
    expect(decodeTruncationCursor(cursor)).toEqual({
      artifactId: "art-1",
      tool: "search_paid_resources",
      offset: 7
    });
    expect(decodeTruncationCursor("not-a-cursor")).toBeNull();
    expect(decodeTruncationCursor("")).toBeNull();
    expect(
      decodeTruncationCursor(Buffer.from(JSON.stringify({ v: 2 }), "utf8").toString("base64url"))
    ).toBeNull();
  });

  it("stores, pages, and expires artifacts", () => {
    let now = 1_000_000;
    const store = new McpResponseArtifactStore({ ttlMs: 60_000, now: () => now });
    const id = store.store({
      tool: "search_paid_resources",
      originalBytes: 5000,
      omitted: Array.from({ length: 5 }, (_v, i) => ({
        path: "resources",
        kind: "array-item" as const,
        value: { id: `resource_${i}` }
      }))
    });
    expect(id).not.toBeNull();
    expect(store.size()).toBe(1);
    const first = store.getPage(id as string, 0, 2);
    expect(first?.items).toHaveLength(2);
    expect(first?.totalOmitted).toBe(5);
    expect(first?.hasMore).toBe(true);
    expect(first?.nextCursor).not.toBeNull();
    const decoded = decodeTruncationCursor(first?.nextCursor as string);
    expect(decoded?.offset).toBe(2);
    const rest = store.getPage(id as string, 2, 10);
    expect(rest?.items).toHaveLength(3);
    expect(rest?.hasMore).toBe(false);
    expect(rest?.nextCursor).toBeNull();
    expect(store.getPage("missing", 0, 10)).toBeNull();
    now += 61_000;
    expect(store.get(id as string)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("refuses remainders larger than the artifact cap", () => {
    const store = new McpResponseArtifactStore({ maxBytes: 100 });
    expect(
      store.store({
        tool: "search_paid_resources",
        originalBytes: 5000,
        omitted: [{ path: "resources", kind: "array-item", value: "x".repeat(500) }]
      })
    ).toBeNull();
  });

  it("evicts the oldest artifact when the store is full", () => {
    const store = new McpResponseArtifactStore({ maxEntries: 2 });
    const first = store.store({ tool: "a", originalBytes: 1, omitted: [] });
    store.store({ tool: "b", originalBytes: 1, omitted: [] });
    store.store({ tool: "c", originalBytes: 1, omitted: [] });
    expect(store.size()).toBe(2);
    expect(store.get(first as string)).toBeUndefined();
  });
});

describe("streamed (chunked) JSON responses", () => {
  it("chunks JSON text within the byte limit and reassembles exactly", () => {
    const text = JSON.stringify({ data: "x".repeat(1000), emoji: "🚀".repeat(50) });
    const chunks = chunkJsonText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(text);
    expect(JSON.parse(chunks.join(""))).toEqual(JSON.parse(text));
  });

  it("rejects a non-positive chunk size", () => {
    expect(() => chunkJsonText("{}", 0)).toThrow(/chunkBytes must be a positive integer/);
  });

  it("streams chunks that reassemble to the truncated value at the boundary", async () => {
    const value = bigResources(10, 300);
    const policy = {
      ...defaultMcpResponsePolicy,
      budgets: { ...defaultMcpResponsePolicy.budgets, search_paid_resources: 2048 }
    };
    const streamed = serializeTruncatedJsonStream(value, {
      tool: "search_paid_resources",
      policy,
      chunkBytes: 256
    });
    expect(streamed.truncated).toBe(true);
    expect(streamed.truncation?.truncated).toBe(true);
    for (const chunk of streamed.chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(256);
    }
    const reassembled = JSON.parse(streamed.chunks.join("")) as Record<string, unknown>;
    expect(reassembled).toEqual(JSON.parse(streamed.text));
    expect((reassembled.resources as Array<unknown>).length).toBeLessThan(10);
    expect(reassembled.truncation).toMatchObject({
      truncated: true,
      tool: "search_paid_resources"
    });

    const seen: string[] = [];
    for await (const chunk of streamJsonChunks(streamed.text, 256)) {
      seen.push(chunk);
    }
    expect(seen.join("")).toBe(streamed.text);
  });

  it("keeps an under-budget streamed response untruncated", () => {
    const value = { ok: true, count: 2 };
    const streamed = serializeTruncatedJsonStream(value, {
      tool: "list_supported_networks",
      chunkBytes: 64
    });
    expect(streamed.truncated).toBe(false);
    expect(streamed.chunks.join("")).toBe(JSON.stringify(value));
  });
});
