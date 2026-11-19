import { describe, expect, it } from "vitest";

import {
  PUBLIC_CATALOG_CACHE_CONTROL,
  canonicalJson,
  computeStrongEtag,
  ifNoneMatchMatches,
  parseIfNoneMatch
} from "./conditional.js";

describe("canonicalJson", () => {
  it("is insensitive to object key order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 })
    );
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("computeStrongEtag", () => {
  it("returns a quoted strong validator", () => {
    const etag = computeStrongEtag({ id: "resource_1", updatedAt: "2026-11-18T00:00:00.000Z" });
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("is deterministic for the same representation", () => {
    const body = { resources: [{ id: "a", name: "Weather" }], nextCursor: null };
    expect(computeStrongEtag(body)).toBe(computeStrongEtag(body));
    expect(computeStrongEtag({ nextCursor: null, resources: [{ name: "Weather", id: "a" }] })).toBe(
      computeStrongEtag(body)
    );
  });

  it("changes whenever the represented data changes", () => {
    const before = computeStrongEtag({
      id: "resource_1",
      name: "Weather",
      updatedAt: "2026-11-18T00:00:00.000Z"
    });
    expect(
      computeStrongEtag({
        id: "resource_1",
        name: "Weather v2",
        updatedAt: "2026-11-18T00:00:00.000Z"
      })
    ).not.toBe(before);
    // A bare updatedAt bump (e.g. after an update that rewrites the row) also changes it.
    expect(
      computeStrongEtag({
        id: "resource_1",
        name: "Weather",
        updatedAt: "2026-11-18T00:00:01.000Z"
      })
    ).not.toBe(before);
  });
});

describe("parseIfNoneMatch", () => {
  it("returns no tags when the header is absent", () => {
    expect(parseIfNoneMatch(undefined)).toEqual({ star: false, tags: [] });
  });

  it("recognises the star form", () => {
    expect(parseIfNoneMatch("*")).toEqual({ star: true, tags: [] });
  });

  it("splits multiple tags and strips weak prefixes", () => {
    expect(parseIfNoneMatch('W/"abc", "def", "ghi"')).toEqual({
      star: false,
      tags: ["abc", "def", "ghi"]
    });
  });

  it("ignores malformed tokens instead of failing", () => {
    expect(parseIfNoneMatch('not-a-tag, "ok"')).toEqual({ star: false, tags: ["ok"] });
  });
});

describe("ifNoneMatchMatches", () => {
  const etag = '"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"';

  it("matches an exact tag", () => {
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
  });

  it("matches a weak tag with the same opaque part", () => {
    expect(ifNoneMatchMatches(`W/${etag}`, etag)).toBe(true);
  });

  it("matches when any of several tags matches", () => {
    expect(ifNoneMatchMatches(`"other", ${etag}`, etag)).toBe(true);
  });

  it("matches the star form", () => {
    expect(ifNoneMatchMatches("*", etag)).toBe(true);
  });

  it("does not match a different tag", () => {
    expect(
      ifNoneMatchMatches('"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"', etag)
    ).toBe(false);
  });

  it("does not match when the header is absent or malformed", () => {
    expect(ifNoneMatchMatches(undefined, etag)).toBe(false);
    expect(ifNoneMatchMatches("not-a-tag", etag)).toBe(false);
  });
});

describe("public catalog cache policy", () => {
  it("uses a public, short-lived cache directive", () => {
    expect(PUBLIC_CATALOG_CACHE_CONTROL).toBe("public, max-age=60");
  });
});
