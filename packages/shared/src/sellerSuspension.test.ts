import { describe, expect, it } from "vitest";

import {
  assertSellerActiveForOperation,
  assertSellerNotSuspendedForOperation,
  classifySellerHttpOperation,
  isSellerOperationBlockedForSuspendedSeller,
  isSellerSuspended,
  sellerSuspensionFromSeller,
  shouldSkipSuspendedSellerWork,
  type SellerSuspensionInfo
} from "./sellerSuspension.js";
import { LumenError } from "./errors.js";

const active: SellerSuspensionInfo = {
  status: "active",
  suspendedAt: null,
  suspensionReason: null
};

const suspended: SellerSuspensionInfo = {
  status: "suspended",
  suspendedAt: "2026-11-19T08:00:00.000Z",
  suspensionReason: "operator review"
};

describe("seller suspension policy", () => {
  it("treats sellers without a status as active", () => {
    expect(sellerSuspensionFromSeller({})).toEqual(active);
    expect(isSellerSuspended({})).toBe(false);
  });

  it("normalizes a Date suspendedAt to ISO", () => {
    expect(
      sellerSuspensionFromSeller({
        status: "suspended",
        suspendedAt: new Date("2026-11-19T08:00:00.000Z"),
        suspensionReason: "operator review"
      })
    ).toEqual(suspended);
  });

  it("blocks write and paid operations for suspended sellers only", () => {
    expect(isSellerOperationBlockedForSuspendedSeller("write")).toBe(true);
    expect(isSellerOperationBlockedForSuspendedSeller("paid")).toBe(true);
    expect(isSellerOperationBlockedForSuspendedSeller("read")).toBe(false);
    expect(isSellerOperationBlockedForSuspendedSeller("recovery")).toBe(false);
  });

  it("allows every operation kind for active sellers", () => {
    for (const kind of ["write", "paid", "read", "recovery"] as const) {
      expect(() => assertSellerNotSuspendedForOperation(active, kind, "seller_1")).not.toThrow();
    }
  });

  it("throws SELLER_SUSPENDED (403) for write and paid operations while suspended", () => {
    for (const kind of ["write", "paid"] as const) {
      try {
        assertSellerNotSuspendedForOperation(suspended, kind, "seller_1");
        expect.unreachable("expected SELLER_SUSPENDED");
      } catch (error) {
        expect(error).toBeInstanceOf(LumenError);
        const lumen = error as LumenError;
        expect(lumen.code).toBe("SELLER_SUSPENDED");
        expect(lumen.statusCode).toBe(403);
        expect(lumen.details).toEqual({ sellerId: "seller_1", operationKind: kind });
      }
    }
  });

  it("allows read and recovery operations while suspended", () => {
    for (const kind of ["read", "recovery"] as const) {
      expect(() => assertSellerNotSuspendedForOperation(suspended, kind, "seller_1")).not.toThrow();
    }
  });

  it("resolves suspension state through a resolver and skips unknown sellers", async () => {
    const resolve = async (sellerId: string) =>
      sellerId === "seller_suspended" ? suspended : null;
    await expect(
      assertSellerActiveForOperation(resolve, "seller_suspended", "write")
    ).rejects.toMatchObject({ code: "SELLER_SUSPENDED" });
    await expect(
      assertSellerActiveForOperation(resolve, "seller_suspended", "read")
    ).resolves.toBeUndefined();
    await expect(
      assertSellerActiveForOperation(resolve, "seller_unknown", "write")
    ).resolves.toBeUndefined();
  });

  it("classifies HTTP operations: reads pass, revocation and domain verification recover, other writes block", () => {
    expect(classifySellerHttpOperation("GET", "/v1/sellers/:sellerId")).toBe("read");
    expect(classifySellerHttpOperation("GET", "/v1/sellers/:sellerId/resources")).toBe("read");
    expect(classifySellerHttpOperation("POST", "/v1/sellers/:sellerId/resources")).toBe("write");
    expect(classifySellerHttpOperation("PATCH", "/v1/resources/:id")).toBe("write");
    expect(classifySellerHttpOperation("DELETE", "/v1/sellers/:sellerId/api-keys/:keyId")).toBe(
      "recovery"
    );
    expect(
      classifySellerHttpOperation("DELETE", "/v1/sellers/:sellerId/webhooks/:endpointId")
    ).toBe("recovery");
    expect(classifySellerHttpOperation("PATCH", "/v1/sellers/:sellerId/webhooks/:endpointId")).toBe(
      "write"
    );
    expect(
      classifySellerHttpOperation("POST", "/v1/sellers/:sellerId/api-keys/:keyId/rotate")
    ).toBe("write");
    expect(classifySellerHttpOperation("POST", "/v1/sellers/:sellerId/verify-domain")).toBe(
      "recovery"
    );
  });

  it("marks queued work for suspended sellers to skip, and nothing else", () => {
    expect(shouldSkipSuspendedSellerWork(suspended)).toBe(true);
    expect(shouldSkipSuspendedSellerWork(active)).toBe(false);
    expect(shouldSkipSuspendedSellerWork(null)).toBe(false);
  });
});
