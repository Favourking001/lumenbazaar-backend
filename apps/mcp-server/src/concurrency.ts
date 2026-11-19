/**
 * Per-client and global concurrency bounds for MCP tool execution.
 *
 * These bounds limit how many tool calls execute at the same time. They are
 * separate from the HTTP request-rate limit (apps/mcp-server/src/http.ts),
 * which counts requests per time window: a client may be under the rate
 * limit yet still be refused here while too many of its calls are in flight.
 *
 * Acquiring is non-blocking and fail-closed: when a bound would be exceeded
 * the call is rejected immediately with a typed error and never starts, so
 * a rejected paid call can never charge anything. Every acquired slot is
 * released in a `finally` (or on cancellation), so a cancelled or failed
 * call frees its capacity.
 */

import { ConcurrencyLimitError } from "./errors.js";

export type McpToolConcurrencyLimits = {
  /** Maximum tool calls executing concurrently for one client. */
  perClient: number;
  /** Maximum tool calls executing concurrently across all clients. */
  global: number;
};

export const DEFAULT_MCP_TOOL_CONCURRENCY_LIMITS: McpToolConcurrencyLimits = {
  perClient: 5,
  global: 50
};

export function resolveMcpToolConcurrencyLimits(
  input: Partial<McpToolConcurrencyLimits> = {}
): McpToolConcurrencyLimits {
  const perClient = input.perClient ?? DEFAULT_MCP_TOOL_CONCURRENCY_LIMITS.perClient;
  const global = input.global ?? DEFAULT_MCP_TOOL_CONCURRENCY_LIMITS.global;
  if (!Number.isInteger(perClient) || perClient < 1) {
    throw new Error("MCP tool concurrency limit perClient must be a positive integer.");
  }
  if (!Number.isInteger(global) || global < 1) {
    throw new Error("MCP tool concurrency limit global must be a positive integer.");
  }
  if (perClient > global) {
    throw new Error("MCP tool concurrency limit perClient must not exceed global.");
  }
  return { perClient, global };
}

export type McpClientIdentity = {
  /**
   * Authenticated client identity where available: the client ID of a
   * validated access token (MCP SDK `RequestHandlerExtra.authInfo.clientId`)
   * or an identity supplied by the transport's own authentication.
   */
  clientId?: string;
  /** Transport session ID, used only when no authenticated identity exists. */
  sessionId?: string;
};

/**
 * Resolve the concurrency bucket key for one tool call.
 *
 * Priority: authenticated client identity first, then the transport session
 * (so unauthenticated callers on different sessions do not share a bucket),
 * then a single `anonymous` bucket for callers with neither.
 */
export function resolveMcpClientKey(identity: McpClientIdentity = {}): string {
  const clientId = identity.clientId?.trim();
  if (clientId !== undefined && clientId !== "") {
    return `client:${clientId.slice(0, 200)}`;
  }
  const sessionId = identity.sessionId?.trim();
  if (sessionId !== undefined && sessionId !== "") {
    return `session:${sessionId.slice(0, 200)}`;
  }
  return "anonymous";
}

export type ConcurrencyAcquireResult =
  | { acquired: true; release: () => void }
  | { acquired: false; scope: "client" | "global" };

/**
 * Synchronous, non-blocking per-client + global concurrency limiter.
 * Single-process and in-memory: each server instance enforces its own
 * bounds, matching the existing in-memory HTTP request guard.
 */
export class McpToolConcurrencyLimiter {
  private readonly limits: McpToolConcurrencyLimits;
  private globalActive = 0;
  private readonly perClientActive = new Map<string, number>();

  constructor(limits: Partial<McpToolConcurrencyLimits> = {}) {
    this.limits = resolveMcpToolConcurrencyLimits(limits);
  }

  getLimits(): McpToolConcurrencyLimits {
    return { ...this.limits };
  }

  activeFor(clientKey: string): number {
    return this.perClientActive.get(clientKey) ?? 0;
  }

  activeGlobal(): number {
    return this.globalActive;
  }

  snapshot(): {
    global: { active: number; limit: number };
    perClient: Record<string, number>;
  } {
    return {
      global: { active: this.globalActive, limit: this.limits.global },
      perClient: Object.fromEntries(this.perClientActive)
    };
  }

  tryAcquire(clientKey: string): ConcurrencyAcquireResult {
    const clientActive = this.perClientActive.get(clientKey) ?? 0;
    if (clientActive >= this.limits.perClient) {
      return { acquired: false, scope: "client" };
    }
    if (this.globalActive >= this.limits.global) {
      return { acquired: false, scope: "global" };
    }
    this.perClientActive.set(clientKey, clientActive + 1);
    this.globalActive += 1;
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        const current = this.perClientActive.get(clientKey) ?? 0;
        if (current <= 1) {
          this.perClientActive.delete(clientKey);
        } else {
          this.perClientActive.set(clientKey, current - 1);
        }
        this.globalActive = Math.max(0, this.globalActive - 1);
      }
    };
  }

  /**
   * Acquire a slot or throw the typed fail-closed error. Convenience wrapper
   * for the tool handler; the caller must still call `release` in `finally`.
   */
  acquireOrThrow(clientKey: string): () => void {
    const result = this.tryAcquire(clientKey);
    if (!result.acquired) {
      throw new ConcurrencyLimitError(result.scope, {
        limit: result.scope === "client" ? this.limits.perClient : this.limits.global,
        active: result.scope === "client" ? this.activeFor(clientKey) : this.globalActive
      });
    }
    return result.release;
  }
}

/**
 * Race `work` against an abort signal. When the signal fires first, the
 * returned promise rejects with a cancellation error; the underlying work
 * keeps running in the background (its result is discarded) so a settled
 * paid operation can still be reconciled via `get_payment_receipt`, but it
 * no longer holds a concurrency slot — the caller releases in `finally`.
 */
export function raceWithCancellation<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal === undefined || signal.aborted) {
    return signal?.aborted === true ? Promise.reject(new Error("Tool call cancelled.")) : work;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("Tool call cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
