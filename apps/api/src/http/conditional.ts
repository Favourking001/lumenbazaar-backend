import { createHash } from "node:crypto";

import { type FastifyReply, type FastifyRequest } from "fastify";

/**
 * Conditional request support (RFC 9110) for public catalog reads.
 *
 * Public catalog representations (resource lists, single resources, discovery
 * browse, and discovery search) are the same for every caller, so they carry
 * a strong ETag derived from the exact response body plus
 * `Cache-Control: public, max-age=60`. A matching `If-None-Match` returns
 * 304 with no body.
 *
 * Authorization-specific responses (resource version history and
 * seller-scoped resource lists) MUST NOT be shared publicly: they carry no
 * ETag and are marked `Cache-Control: private, no-store` with
 * `Vary: X-Api-Key`.
 */

/** Shared-cache lifetime for public catalog representations, in seconds. */
export const PUBLIC_CATALOG_MAX_AGE_SECONDS = 60;

export const PUBLIC_CATALOG_CACHE_CONTROL = `public, max-age=${PUBLIC_CATALOG_MAX_AGE_SECONDS}`;

/** Never stored by any cache; never shared between callers. */
export const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store";

/** Name of the header carrying the seller credential. */
export const SELLER_API_KEY_HEADER = "X-Api-Key";

/**
 * Deterministic JSON serialization: object keys are sorted recursively so
 * the same representation always hashes the same way regardless of key
 * insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * Strong ETag for a response body: SHA-256 of the canonical JSON form of
 * the representation, quoted per RFC 9110. The tag changes whenever any
 * part of the represented data changes (including `updatedAt`).
 */
export function computeStrongEtag(body: unknown): string {
  return `"${createHash("sha256").update(canonicalJson(body), "utf8").digest("hex")}"`;
}

export type ParsedIfNoneMatch = {
  /** `If-None-Match: *` matches any current representation. */
  star: boolean;
  /** Opaque tags, with any `W/` prefix and quotes stripped. */
  tags: string[];
};

export function parseIfNoneMatch(header: string | undefined): ParsedIfNoneMatch {
  if (header === undefined) {
    return { star: false, tags: [] };
  }
  const tags: string[] = [];
  for (const raw of header.split(",")) {
    const token = raw.trim();
    if (token === "*") {
      return { star: true, tags: [] };
    }
    const match = /^W\/"(.*)"$/.exec(token) ?? /^"(.*)"$/.exec(token);
    if (match !== null && match[1] !== undefined) {
      tags.push(match[1]);
    }
    // Malformed tokens are ignored (RFC 9110: a recipient MUST ignore an
    // If-None-Match field it cannot parse) rather than failing the request.
  }
  return { star: false, tags };
}

/**
 * Weak comparison (RFC 9110 section 8.8.3.2): two tags match when their
 * opaque parts are identical, regardless of the `W/` weak prefix. Used for
 * `If-None-Match` on GET/HEAD, where a weak match is enough for a 304.
 */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  const parsed = parseIfNoneMatch(header);
  if (parsed.star) {
    return true;
  }
  const current = parseIfNoneMatch(etag).tags[0];
  if (current === undefined) {
    return false;
  }
  return parsed.tags.includes(current);
}

/**
 * Apply conditional-GET handling to a public catalog response.
 *
 * Always sets `ETag` and `Cache-Control: public, max-age=60`. When the
 * request's `If-None-Match` matches the current ETag (including `*` and
 * weak tags), sends a 304 with those headers and no body; otherwise
 * returns the body for Fastify to send as a 200.
 */
export function sendConditionalGet(
  request: FastifyRequest,
  reply: FastifyReply,
  body: unknown
): unknown {
  const etag = computeStrongEtag(body);
  reply.header("etag", etag);
  reply.header("cache-control", PUBLIC_CATALOG_CACHE_CONTROL);
  if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
    return reply.code(304).send();
  }
  return body;
}

/**
 * Mark an authorization-specific response as uncacheable and unshareable:
 * no ETag is emitted, shared caches must not store it, and caches must
 * vary on the seller credential.
 */
export function applyPrivateNoStore(reply: FastifyReply): void {
  reply.header("cache-control", PRIVATE_NO_STORE_CACHE_CONTROL);
  reply.header("vary", SELLER_API_KEY_HEADER);
}
