/**
 * Focused coverage for MCP tool concurrency limits (issue #119):
 * per-client and global bounds, unauthenticated fallback identity,
 * cancellation releasing capacity, fail-closed limit breaches, and
 * paid-operation idempotency/reconciliation preserved under the limits.
 *
 * All fixtures use synthetic testnet data only; no live network calls.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";

import { testPaymentPayload } from "@lumenbazaar/testkit";

import { BackendClient } from "./client.js";
import {
  DEFAULT_MCP_TOOL_CONCURRENCY_LIMITS,
  McpToolConcurrencyLimiter,
  resolveMcpClientKey,
  resolveMcpToolConcurrencyLimits
} from "./concurrency.js";
import { ConcurrencyLimitError } from "./errors.js";
import { type McpPaymentToolService } from "./paymentTools.js";
import { createMcpServer, type CreateMcpServerOptions } from "./server.js";

describe("resolveMcpClientKey", () => {
  it("keys on the authenticated client identity where available", () => {
    expect(resolveMcpClientKey({ clientId: "client-123", sessionId: "sess-1" })).toBe(
      "client:client-123"
    );
  });

  it("falls back to the transport session for unauthenticated callers", () => {
    expect(resolveMcpClientKey({ sessionId: "sess-1" })).toBe("session:sess-1");
    expect(resolveMcpClientKey({ sessionId: "sess-2" })).toBe("session:sess-2");
  });

  it("falls back to a single anonymous bucket with neither identity nor session", () => {
    expect(resolveMcpClientKey({})).toBe("anonymous");
    expect(resolveMcpClientKey({ clientId: "   ", sessionId: "" })).toBe("anonymous");
  });
});

describe("resolveMcpToolConcurrencyLimits", () => {
  it("defaults to 5 per client / 50 global", () => {
    expect(resolveMcpToolConcurrencyLimits()).toEqual({ perClient: 5, global: 50 });
    expect(DEFAULT_MCP_TOOL_CONCURRENCY_LIMITS).toEqual({ perClient: 5, global: 50 });
  });

  it("rejects non-positive or per-client-above-global bounds", () => {
    expect(() => resolveMcpToolConcurrencyLimits({ perClient: 0 })).toThrow();
    expect(() => resolveMcpToolConcurrencyLimits({ global: 0 })).toThrow();
    expect(() => resolveMcpToolConcurrencyLimits({ perClient: 10, global: 5 })).toThrow();
  });
});

describe("McpToolConcurrencyLimiter", () => {
  it("enforces the per-client limit and frees the slot on release", () => {
    const limiter = new McpToolConcurrencyLimiter({ perClient: 2, global: 10 });
    const first = limiter.tryAcquire("client:a");
    const second = limiter.tryAcquire("client:a");
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(limiter.tryAcquire("client:a")).toEqual({ acquired: false, scope: "client" });
    expect(limiter.activeFor("client:a")).toBe(2);
    if (first.acquired) first.release();
    expect(limiter.tryAcquire("client:a").acquired).toBe(true);
  });

  it("enforces the global limit across different clients", () => {
    const limiter = new McpToolConcurrencyLimiter({ perClient: 2, global: 2 });
    expect(limiter.tryAcquire("client:a").acquired).toBe(true);
    expect(limiter.tryAcquire("client:b").acquired).toBe(true);
    expect(limiter.tryAcquire("client:c")).toEqual({ acquired: false, scope: "global" });
    expect(limiter.activeGlobal()).toBe(2);
  });

  it("makes release idempotent and drops empty per-client entries", () => {
    const limiter = new McpToolConcurrencyLimiter({ perClient: 1, global: 1 });
    const slot = limiter.tryAcquire("client:a");
    expect(slot.acquired).toBe(true);
    if (slot.acquired) {
      slot.release();
      slot.release();
    }
    expect(limiter.activeGlobal()).toBe(0);
    expect(limiter.snapshot().perClient).toEqual({});
    expect(limiter.tryAcquire("client:a").acquired).toBe(true);
  });

  it("acquireOrThrow raises the typed fail-closed error", () => {
    const limiter = new McpToolConcurrencyLimiter({ perClient: 1, global: 1 });
    limiter.acquireOrThrow("client:a");
    expect(() => limiter.acquireOrThrow("client:a")).toThrow(ConcurrencyLimitError);
    try {
      limiter.acquireOrThrow("client:a");
    } catch (error) {
      expect(error).toBeInstanceOf(ConcurrencyLimitError);
      expect((error as ConcurrencyLimitError).code).toBe("CONCURRENCY_LIMIT_EXCEEDED");
    }
  });
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
};

async function connectPairedClient(options: CreateMcpServerOptions) {
  const server = createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  const client = new Client({ name: "concurrency-test-client", version: "1.0.0" });
  await client.connect(clientTransport as unknown as Transport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

function mockBackendWithSlowSearch() {
  const backend = new BackendClient("https://api.example.test");
  const gate = deferred<{
    resources: Array<Record<string, unknown>>;
  }>();
  vi.spyOn(backend, "searchResources").mockImplementation(() => gate.promise);
  return { backend, gate };
}

describe("MCP tool concurrency limits over the protocol", () => {
  it("rejects a second call from the same client at the per-client limit", async () => {
    const limiter = new McpToolConcurrencyLimiter({ perClient: 1, global: 10 });
    const { backend, gate } = mockBackendWithSlowSearch();
    const { client, close } = await connectPairedClient({
      client: backend,
      capabilityProvider: async () => ({ backend: true, exact: false }),
      concurrencyLimiter: limiter,
      clientIdentityProvider: () => "client-a"
    });
    try {
      const first = client.callTool({
        name: "search_paid_resources",
        arguments: { query: "weather" }
      });
      // The first call holds the only per-client slot; the second must fail
      // closed without ever reaching the backend.
      const second = await client.callTool({
        name: "search_paid_resources",
        arguments: { query: "weather" }
      });
      expect(second.isError).toBe(true);
      expect(JSON.stringify(second.content)).toContain("CONCURRENCY_LIMIT_EXCEEDED");
      expect(backend.searchResources).toHaveBeenCalledTimes(1);

      gate.resolve({ resources: [] });
      const firstResult = await first;
      expect(firstResult.isError).not.toBe(true);
      expect(limiter.activeGlobal()).toBe(0);

      // Capacity freed: the next call from the same client succeeds.
      gate.resolve({ resources: [] });
      const third = await client.callTool({
        name: "search_paid_resources",
        arguments: { query: "weather" }
      });
      expect(third.isError).not.toBe(true);
    } finally {
      await close();
    }
  });

  it("enforces the global limit across different clients", async () => {
    const limiter = new McpToolConcurrencyLimiter({ perClient: 1, global: 1 });
    const { backend, gate } = mockBackendWithSlowSearch();
    const { client, close } = await connectPairedClient({
      client: backend,
      capabilityProvider: async () => ({ backend: true, exact: false }),
      concurrencyLimiter: limiter,
      // Key the identity off the request itself so the two concurrent
      // calls are deterministically different clients.
      clientIdentityProvider: (request) => {
        const args = (request as { params?: { arguments?: Record<string, unknown> } }).params
          ?.arguments;
        return args?.query === "weather-b" ? "client-b" : "client-a";
      }
    });
    try {
      const first = client.callTool({
        name: "search_paid_resources",
        arguments: { query: "weather-a" }
      });
      first.catch(() => {});
      const second = await client.callTool({
        name: "search_paid_resources",
        arguments: { query: "weather-b" }
      });
      expect(second.isError).toBe(true);
      expect(JSON.stringify(second.content)).toContain("CONCURRENCY_LIMIT_EXCEEDED");
      const secondError = JSON.parse((second.content as Array<{ text: string }>)[0]!.text) as {
        details?: { scope?: string };
      };
      expect(secondError.details?.scope).toBe("global");
      gate.resolve({ resources: [] });
      await first;
      expect(limiter.activeGlobal()).toBe(0);
    } finally {
      gate.resolve({ resources: [] });
      await close();
    }
  });

  it("shares one bucket for unauthenticated callers with no session", async () => {
    const limiter = new McpToolConcurrencyLimiter({ perClient: 1, global: 10 });
    const { backend, gate } = mockBackendWithSlowSearch();
    const { client, close } = await connectPairedClient({
      client: backend,
      capabilityProvider: async () => ({ backend: true, exact: false }),
      concurrencyLimiter: limiter
    });
    try {
      const first = client.callTool({
        name: "search_paid_resources",
        arguments: { query: "weather" }
      });
      const second = await client.callTool({
        name: "search_paid_resources",
        arguments: { query: "weather" }
      });
      expect(second.isError).toBe(true);
      expect(JSON.stringify(second.content)).toContain("CONCURRENCY_LIMIT_EXCEEDED");
      gate.resolve({ resources: [] });
      await first;
      expect(limiter.activeGlobal()).toBe(0);
    } finally {
      await close();
    }
  });

  it("releases capacity when a call is cancelled", async () => {
    const limiter = new McpToolConcurrencyLimiter({ perClient: 1, global: 10 });
    const { backend, gate } = mockBackendWithSlowSearch();
    const { client, close } = await connectPairedClient({
      client: backend,
      capabilityProvider: async () => ({ backend: true, exact: false }),
      concurrencyLimiter: limiter,
      clientIdentityProvider: () => "client-a"
    });
    try {
      const abort = new AbortController();
      const cancelled = client.callTool(
        { name: "search_paid_resources", arguments: { query: "weather" } },
        undefined,
        { signal: abort.signal }
      );
      // Give the server time to acquire the slot before cancelling.
      await vi.waitFor(() => expect(limiter.activeGlobal()).toBe(1));
      abort.abort();
      await expect(cancelled).rejects.toThrow();
      // The cancelled call must free its slot even though the backend
      // work never resolved.
      await vi.waitFor(() => expect(limiter.activeGlobal()).toBe(0));
      gate.resolve({ resources: [] });
      const after = await client.callTool({
        name: "search_paid_resources",
        arguments: { query: "weather" }
      });
      expect(after.isError).not.toBe(true);
    } finally {
      await close();
    }
  });

  it("preserves paid-operation idempotency and reconciliation under the limits", async () => {
    const limiter = new McpToolConcurrencyLimiter({ perClient: 1, global: 10 });
    const receipt = {
      receiptId: "rcpt_concurrency_1",
      status: "settled",
      transactionHash: "a".repeat(64),
      ledger: 123,
      settledAt: "2026-11-19T00:00:00.000Z"
    };
    const paidGate = deferred<Record<string, unknown>>();
    const callPaidResource = vi.fn(() => paidGate.promise);
    const getPaymentReceipt = vi.fn(async () => receipt);
    const paymentTools = {
      callPaidResource,
      getPaymentReceipt,
      preparePayment: vi.fn(),
      inspectBudget: vi.fn(() => ({}))
    } as unknown as McpPaymentToolService;
    const { client, close } = await connectPairedClient({
      capabilityProvider: async () => ({ backend: true, exact: true }),
      paymentTools,
      concurrencyLimiter: limiter,
      clientIdentityProvider: () => "client-a"
    });
    const paidArgs = {
      resourceId: "resource_weather",
      paymentPayload: testPaymentPayload
    };
    try {
      const first = client.callTool({ name: "call_paid_resource", arguments: paidArgs });
      // A concurrent duplicate is refused before entering the payment
      // flow, so the paid operation runs exactly once.
      const duplicate = await client.callTool({
        name: "call_paid_resource",
        arguments: paidArgs
      });
      expect(duplicate.isError).toBe(true);
      expect(JSON.stringify(duplicate.content)).toContain("CONCURRENCY_LIMIT_EXCEEDED");
      expect(callPaidResource).toHaveBeenCalledTimes(1);

      paidGate.resolve({ ...receipt });
      const firstResult = await first;
      expect(firstResult.isError).not.toBe(true);
      expect(JSON.stringify(firstResult.content)).toContain("rcpt_concurrency_1");

      // Sequential retry of the same paid call succeeds with the same
      // receipt: the limiter neither dedupes nor drops it.
      paidGate.resolve({ ...receipt });
      const retry = await client.callTool({
        name: "call_paid_resource",
        arguments: paidArgs
      });
      expect(retry.isError).not.toBe(true);
      expect(JSON.stringify(retry.content)).toContain("rcpt_concurrency_1");
      expect(callPaidResource).toHaveBeenCalledTimes(2);

      // Reconciliation is unaffected: the receipt is still fetchable.
      const fetched = await client.callTool({
        name: "get_payment_receipt",
        arguments: { receiptId: "rcpt_concurrency_1" }
      });
      expect(fetched.isError).not.toBe(true);
      expect(JSON.stringify(fetched.content)).toContain("rcpt_concurrency_1");
      expect(getPaymentReceipt).toHaveBeenCalledWith({ receiptId: "rcpt_concurrency_1" });
    } finally {
      await close();
    }
  });
});
