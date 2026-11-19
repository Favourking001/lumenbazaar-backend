import { LumenError } from "./errors.js";

/**
 * Centralized seller-suspension policy (issue #106).
 *
 * A seller is either `active` or `suspended`. Suspension is an operator
 * action recorded on the seller (`status`, `suspendedAt`,
 * `suspensionReason`); every entry point — HTTP API, MCP tools, and worker
 * queues — enforces it through the helpers in this module so a suspended
 * seller cannot retain access through a different surface.
 *
 * Operation classification:
 * - `write` — creates, updates, or deletes seller-owned state (resources,
 *   catalog entries, API keys, webhook endpoints, stream-access grants).
 * - `paid` — consumes a paid resource or moves money for the seller
 *   (facilitator verify/settle for the seller's resources, new payment
 *   sessions, MCP `prepare_payment` / `call_paid_resource`).
 * - `read` — reads the seller's own data (profiles, resources, receipts,
 *   key/webhook listings). Reads stay available while suspended so the
 *   seller can inspect state and appeal.
 * - `recovery` — actions that stop access or wind state down instead of
 *   creating it: revoking an API key, deleting a webhook endpoint,
 *   verifying a domain, settling an already-open payment session, and
 *   finalizing in-flight settlements/receipts. Recovery stays available
 *   while suspended.
 *
 * Blocked while suspended: `write` and `paid`. Allowed while suspended:
 * `read` and `recovery`. New queued work for a suspended seller (resource
 * indexing, search sync rebuilds, webhook deliveries) is skipped, not
 * retried, until the seller is reinstated; in-flight settlement and
 * receipt finalization continue because buyers have already paid.
 *
 * Suspended sellers' resources are also excluded from discovery and
 * search results, so a suspended seller cannot be reached for a new paid
 * call through the catalog even though single-resource reads still work.
 */

export const SELLER_STATUSES = ["active", "suspended"] as const;

export type SellerStatus = (typeof SELLER_STATUSES)[number];

export function isSellerStatus(value: string): value is SellerStatus {
  return (SELLER_STATUSES as readonly string[]).includes(value);
}

/**
 * The suspension fields carried on a seller record. `null` values mean the
 * seller was never suspended (or was reinstated).
 */
export type SellerSuspensionInfo = {
  status: SellerStatus;
  suspendedAt: string | null;
  suspensionReason: string | null;
};

export type SellerLike = {
  status?: SellerStatus | string | null | undefined;
  suspendedAt?: string | Date | null | undefined;
  suspensionReason?: string | null | undefined;
};

function toIso(value: string | Date | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

export function sellerSuspensionFromSeller(seller: SellerLike): SellerSuspensionInfo {
  const status =
    seller.status !== undefined && seller.status !== null && isSellerStatus(seller.status)
      ? seller.status
      : "active";
  return {
    status,
    suspendedAt: toIso(seller.suspendedAt),
    suspensionReason: seller.suspensionReason ?? null
  };
}

export function isSellerSuspended(info: SellerSuspensionInfo | SellerLike): boolean {
  return sellerSuspensionFromSeller(info).status === "suspended";
}

/** Kinds of seller operations, by what they do rather than which route they came in on. */
export type SellerOperationKind = "write" | "paid" | "read" | "recovery";

/**
 * Whether an operation kind is blocked for a suspended seller.
 * Writes and paid-resource operations are blocked; reads and recovery are not.
 */
export function isSellerOperationBlockedForSuspendedSeller(kind: SellerOperationKind): boolean {
  return kind === "write" || kind === "paid";
}

export function sellerSuspendedError(sellerId: string, kind: SellerOperationKind): LumenError {
  return new LumenError(
    "SELLER_SUSPENDED",
    "Seller is suspended. Write and paid-resource operations are unavailable until the seller is reinstated.",
    {
      details: { sellerId, operationKind: kind }
    }
  );
}

/**
 * Throw `SELLER_SUSPENDED` (403) when the seller is suspended and the
 * operation kind is blocked for suspended sellers. Reads and recovery
 * operations pass through unchanged.
 */
export function assertSellerNotSuspendedForOperation(
  seller: SellerSuspensionInfo | SellerLike,
  kind: SellerOperationKind,
  sellerId?: string
): void {
  const info = sellerSuspensionFromSeller(seller as SellerLike);
  if (info.status === "suspended" && isSellerOperationBlockedForSuspendedSeller(kind)) {
    throw sellerSuspendedError(sellerId ?? "unknown", kind);
  }
}

/** Resolves a seller's suspension state by id. Returns `null` when the seller does not exist. */
export type SellerStatusResolver = (sellerId: string) => Promise<SellerSuspensionInfo | null>;

/**
 * Resolve a seller and enforce the operation kind against suspension.
 * A missing seller resolves to `null` and is left alone here — callers that
 * need the seller to exist still throw `SELLER_NOT_FOUND` themselves.
 */
export async function assertSellerActiveForOperation(
  resolveSellerStatus: SellerStatusResolver,
  sellerId: string,
  kind: SellerOperationKind
): Promise<void> {
  const info = await resolveSellerStatus(sellerId);
  if (info === null) {
    return;
  }
  assertSellerNotSuspendedForOperation(info, kind, sellerId);
}

/**
 * Classify an HTTP operation for suspension enforcement. Reads are `GET`
 * requests; the named recovery routes are `recovery`; every other
 * non-`GET` request is a `write`. Paid flows classify themselves as
 * `paid` at the service level (facilitator, payment sessions, MCP tools).
 */
export function classifySellerHttpOperation(
  method: string,
  route: string | undefined
): SellerOperationKind {
  if (method === "GET") {
    return "read";
  }
  if (method === "DELETE") {
    if (
      route === "/v1/sellers/:sellerId/api-keys/:keyId" ||
      route === "/v1/sellers/:sellerId/webhooks/:endpointId"
    ) {
      return "recovery";
    }
  }
  if (route === "/v1/sellers/:sellerId/verify-domain") {
    return "recovery";
  }
  return "write";
}

/**
 * Worker gate: queued seller work that creates new seller-visible state
 * (indexing, search sync, webhook delivery) is skipped while the seller is
 * suspended. Returns `true` when the job must be skipped. Skipped jobs are
 * complete, not failed, so they are not retried.
 */
export function shouldSkipSuspendedSellerWork(
  info: SellerSuspensionInfo | SellerLike | null
): boolean {
  return info !== null && isSellerSuspended(info);
}
