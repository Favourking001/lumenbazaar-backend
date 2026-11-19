import { describe, expect, it } from "vitest";

import {
  ifMatchHeader,
  isResourceVersionConflict,
  parseIfMatchHeader,
  withExpectedVersion
} from "./optimisticConcurrency.js";

describe("seller SDK optimistic concurrency", () => {
  it("builds a quoted If-Match header from the version read", () => {
    expect(ifMatchHeader(3)).toEqual({ "If-Match": '"3"' });
  });

  it("rejects non-positive or non-integer versions", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => ifMatchHeader(bad)).toThrow(/positive integer/u);
    }
  });

  it("parses quoted and bare If-Match values and tolerates a missing header", () => {
    expect(parseIfMatchHeader('"3"')).toBe(3);
    expect(parseIfMatchHeader("3")).toBe(3);
    expect(parseIfMatchHeader(undefined)).toBeUndefined();
    expect(parseIfMatchHeader(null)).toBeUndefined();
    expect(parseIfMatchHeader("  ")).toBeUndefined();
  });

  it("rejects malformed If-Match values", () => {
    for (const bad of ["*", 'W/"3"', "0", "-1", "3.5", "abc"]) {
      expect(() => parseIfMatchHeader(bad)).toThrow(/If-Match header/u);
    }
  });

  it("attaches the expected version to an update body without mutating it", () => {
    const body = { name: "Paid Forecast API" };
    expect(withExpectedVersion(body, 2)).toEqual({ name: "Paid Forecast API", version: 2 });
    expect(body).toEqual({ name: "Paid Forecast API" });
  });

  it("recognises a stale-write conflict error body", () => {
    expect(isResourceVersionConflict({ code: "RESOURCE_VERSION_CONFLICT" })).toBe(true);
    expect(isResourceVersionConflict({ statusCode: 409 })).toBe(true);
    expect(isResourceVersionConflict({ code: "VALIDATION_FAILED" })).toBe(false);
  });
});
