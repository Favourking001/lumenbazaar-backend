import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { parseIfMatchHeader } from "./validation.js";

function requestWithIfMatch(value: string | string[] | undefined): FastifyRequest {
  return {
    headers: value === undefined ? {} : { "if-match": value }
  } as FastifyRequest;
}

describe("parseIfMatchHeader", () => {
  it("parses quoted and bare versions and tolerates a missing header", () => {
    expect(parseIfMatchHeader(requestWithIfMatch('"3"'))).toBe(3);
    expect(parseIfMatchHeader(requestWithIfMatch("3"))).toBe(3);
    expect(parseIfMatchHeader(requestWithIfMatch(undefined))).toBeUndefined();
    expect(parseIfMatchHeader(requestWithIfMatch(['"4"', '"5"']))).toBe(4);
  });

  it("rejects malformed preconditions with a typed validation error", () => {
    for (const bad of ["*", 'W/"3"', "0", "-1", "3.5", "abc", '""']) {
      expect(() => parseIfMatchHeader(requestWithIfMatch(bad))).toThrowError(
        expect.objectContaining({
          code: "VALIDATION_FAILED",
          message: expect.stringMatching(/If-Match header must be a positive integer/u)
        })
      );
    }
  });
});
