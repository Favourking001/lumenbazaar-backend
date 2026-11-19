import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";

import {
  chunkJsonText,
  decodeTruncationCursor,
  defaultMcpResponsePolicy,
  type McpResponsePolicy
} from "@lumenbazaar/shared";

import { BackendClient } from "./client.js";
import { startMcpHttpServer } from "./http.js";
import { getToolDefinition } from "./tools.js";

const paymentTerms = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CB256KDRXDO2FYJN3YBYZE5KCU46WIIE67DRP5T7HI45DRH2GM6YOJFS",
  amount: "200000",
  payTo: "GBZXN7PIRZGNMHGAIQW7QEJWW36L5CVVNRYANMDW2G3QOF2VCR4DQSQE",
  maxTimeoutSeconds: 60,
  extra: { assetCode: "USDC" }
};

function bigResources(count: number, descriptionLength: number) {
  return Array.from({ length: count }, (_value, index) => ({
    id: `resource_${index}`,
    name: `Resource ${index}`,
    description: "x".repeat(descriptionLength),
    type: "http",
    url: `https://resource.example.test/${index}`,
    paymentTerms
  }));
}

function smallPolicy(overrides: Record<string, number>): McpResponsePolicy {
  return {
    ...defaultMcpResponsePolicy,
    budgets: { ...defaultMcpResponsePolicy.budgets, ...overrides }
  };
}

async function startTestServer(
  backend: BackendClient,
  responsePolicy: McpResponsePolicy,
  capabilities: { backend: boolean; exact: boolean } = { backend: true, exact: false }
) {
  const server = await startMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    client: backend,
    capabilityProvider: async () => capabilities,
    responsePolicy
  });
  const transport = new StreamableHTTPClientTransport(new URL(server.url));
  const client = new Client({ name: "response-policy-test-client", version: "1.0.0" });
  await client.connect(transport as unknown as Transport);
  return { server, client };
}

type Structured = Record<string, unknown>;

describe("MCP response size and truncation policy", () => {
  it("advertises get_response_artifact and a truncation field on tool output schemas", async () => {
    const backend = new BackendClient("https://api.example.test");
    const { server, client } = await startTestServer(
      backend,
      smallPolicy({ search_paid_resources: 2048 })
    );
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("get_response_artifact");
      const search = listed.tools.find((tool) => tool.name === "search_paid_resources");
      const outputSchema = search?.outputSchema as unknown as {
        properties?: Record<string, unknown>;
      };
      expect(outputSchema.properties).toHaveProperty("truncation");
      const artifact = listed.tools.find((tool) => tool.name === "get_response_artifact");
      expect(artifact?.outputSchema).toBeDefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns under-budget JSON results unchanged and at-budget results untruncated", async () => {
    const backend = new BackendClient("https://api.example.test");
    vi.spyOn(backend, "searchResources").mockResolvedValue({
      resources: [
        {
          id: "resource_small",
          name: "Small",
          description: "tiny",
          type: "http",
          url: "https://resource.example.test/small",
          paymentTerms
        }
      ]
    });
    const { server, client } = await startTestServer(
      backend,
      smallPolicy({ search_paid_resources: 2048 })
    );
    try {
      const result = await client.callTool({
        name: "search_paid_resources",
        arguments: { query: "small", limit: 1 }
      });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as Structured;
      expect(structured.truncation).toBeUndefined();
      expect(structured.resources).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("truncates an over-budget streamed search result explicitly and stays schema-valid", async () => {
    const backend = new BackendClient("https://api.example.test");
    vi.spyOn(backend, "searchResources").mockResolvedValue({
      resources: bigResources(20, 500),
      total: 20
    });
    const { server, client } = await startTestServer(
      backend,
      smallPolicy({ search_paid_resources: 2048 })
    );
    try {
      // The call travels over the Streamable HTTP (SSE) transport, so this
      // is the streamed path as well as the JSON path.
      const result = await client.callTool({
        name: "search_paid_resources",
        arguments: { query: "weather", limit: 20 }
      });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as Structured;
      const truncation = structured.truncation as Structured;
      expect(truncation).toMatchObject({
        truncated: true,
        tool: "search_paid_resources",
        budgetBytes: 2048,
        originalBytes: expect.any(Number),
        reason: "response_exceeds_budget"
      });
      expect(truncation.originalBytes as number).toBeGreaterThan(2048);
      expect(truncation.truncatedBytes).toBe(Buffer.byteLength(JSON.stringify(structured), "utf8"));
      expect(Buffer.byteLength(JSON.stringify(structured), "utf8")).toBeLessThanOrEqual(2048);
      const resources = structured.resources as Array<Record<string, unknown>>;
      expect(resources.length).toBeGreaterThan(0);
      expect(resources.length).toBeLessThan(20);
      expect(truncation.omittedItems).toBe(20 - resources.length);
      expect(truncation.artifactId).toBeDefined();
      expect(truncation.cursor).toBeDefined();
      expect(decodeTruncationCursor(truncation.cursor as string)?.offset).toBe(0);

      // The truncated value still validates against the tool output schema.
      const definition = getToolDefinition("search_paid_resources");
      expect(() => definition?.outputSchema.parse(structured)).not.toThrow();

      // Streamed boundary: the same JSON text split into small chunks
      // reassembles exactly to the truncated value.
      const text = JSON.stringify(structured);
      const chunks = chunkJsonText(text, 256);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(256);
      }
      expect(JSON.parse(chunks.join(""))).toEqual(structured);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("retrieves the omitted remainder through the artifact cursor, page by page", async () => {
    const backend = new BackendClient("https://api.example.test");
    vi.spyOn(backend, "searchResources").mockResolvedValue({
      resources: bigResources(20, 500),
      total: 20
    });
    const { server, client } = await startTestServer(
      backend,
      smallPolicy({ search_paid_resources: 2048 })
    );
    try {
      const result = await client.callTool({
        name: "search_paid_resources",
        arguments: { query: "weather", limit: 20 }
      });
      const structured = result.structuredContent as Structured;
      const truncation = structured.truncation as Structured;
      const artifactId = truncation.artifactId as string;
      const omittedItems = truncation.omittedItems as number;
      expect(omittedItems).toBeGreaterThan(0);

      const first = await client.callTool({
        name: "get_response_artifact",
        arguments: { artifactId, offset: 0, limit: 2 }
      });
      expect(first.isError).not.toBe(true);
      const firstPage = first.structuredContent as Structured;
      expect(firstPage).toMatchObject({
        artifactId,
        tool: "search_paid_resources",
        truncated: true,
        totalOmitted: omittedItems,
        hasMore: true
      });
      expect(firstPage.items as Array<unknown>).toHaveLength(2);
      const nextCursor = firstPage.nextCursor as string;
      expect(decodeTruncationCursor(nextCursor)?.offset).toBe(2);

      const rest = await client.callTool({
        name: "get_response_artifact",
        arguments: { artifactId, offset: 2, limit: 100 }
      });
      const restPage = rest.structuredContent as Structured;
      expect(restPage.hasMore).toBe(false);
      expect(restPage.nextCursor).toBeUndefined();
      const retrieved = [
        ...(firstPage.items as Array<Record<string, unknown>>),
        ...(restPage.items as Array<Record<string, unknown>>)
      ];
      expect(retrieved).toHaveLength(omittedItems);
      // The retrieved remainder covers the resources the truncation dropped.
      const droppedIds = retrieved
        .map((entry) => (entry.value as Record<string, unknown> | undefined)?.id)
        .filter((id): id is string => typeof id === "string");
      const keptIds = new Set(
        (structured.resources as Array<Record<string, unknown>>).map((r) => r.id)
      );
      expect(droppedIds.length).toBeGreaterThan(0);
      for (const id of droppedIds) expect(keptIds.has(id)).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an error for an unknown or expired artifact id", async () => {
    const backend = new BackendClient("https://api.example.test");
    const { server, client } = await startTestServer(
      backend,
      smallPolicy({ get_response_artifact: 128 * 1024 })
    );
    try {
      const result = await client.callTool({
        name: "get_response_artifact",
        arguments: { artifactId: "no-such-artifact" }
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("RESOURCE_NOT_FOUND");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("preserves payment evidence when truncating a receipt result", async () => {
    const backend = new BackendClient("https://api.example.test");
    const receipt = {
      id: "receipt_testnet_001",
      correlationId: "corr-testnet-001",
      transactionHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      ledger: 123456,
      network: "stellar:testnet",
      amount: "200000",
      assetCode: "USDC",
      assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      status: "settled",
      settledAt: "2026-11-19T07:00:00.000Z",
      debug: "z".repeat(8000)
    };
    vi.spyOn(backend, "getReceipt").mockResolvedValue(receipt);
    const { server, client } = await startTestServer(
      backend,
      smallPolicy({ get_payment_receipt: 2048 })
    );
    try {
      const result = await client.callTool({
        name: "get_payment_receipt",
        arguments: { receiptId: "receipt_testnet_001" }
      });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as Structured;
      expect(structured.truncation).toMatchObject({ truncated: true });
      // The receipt is flat in this tool's result, so the evidence fields
      // live at the top level and must survive truncation verbatim.
      expect(structured.transactionHash).toBe("a".repeat(64));
      expect(structured.evidenceHash).toBe("b".repeat(64));
      expect(structured.correlationId).toBe("corr-testnet-001");
      expect(structured.ledger).toBe(123456);
      expect(structured.id).toBe("receipt_testnet_001");
      expect(Buffer.byteLength(JSON.stringify(structured), "utf8")).toBeLessThanOrEqual(2048);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("fails explicitly instead of silently dropping oversized payment evidence", async () => {
    const backend = new BackendClient("https://api.example.test");
    vi.spyOn(backend, "getReceipt").mockResolvedValue({
      id: "receipt_testnet_002",
      correlationId: "corr-testnet-002",
      transactionHash: "a".repeat(3000),
      evidenceHash: "b".repeat(3000),
      ledger: 123456,
      network: "stellar:testnet",
      amount: "200000",
      assetCode: "USDC",
      status: "settled"
    });
    const { server, client } = await startTestServer(
      backend,
      smallPolicy({ get_payment_receipt: 1024 })
    );
    try {
      const result = await client.callTool({
        name: "get_payment_receipt",
        arguments: { receiptId: "receipt_testnet_002" }
      });
      expect(result.isError).toBe(true);
      const content = JSON.stringify(result.content);
      expect(content).toContain("RESPONSE_TOO_LARGE");
      expect(content).toContain("get_payment_receipt");
      // The oversized evidence itself is not echoed back in the error.
      expect(content).not.toContain("a".repeat(64));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
