import { type FastifyRequest } from "fastify";
import { type z } from "zod";

import { LumenError } from "@lumenbazaar/shared";

export function parseBody<TSchema extends z.ZodType>(request: FastifyRequest, schema: TSchema) {
  return schema.parse(request.body) as z.output<TSchema>;
}

export function parseQuery<TSchema extends z.ZodType>(request: FastifyRequest, schema: TSchema) {
  return schema.parse(request.query) as z.output<TSchema>;
}

export function parseParams<TSchema extends z.ZodType>(request: FastifyRequest, schema: TSchema) {
  return schema.parse(request.params) as z.output<TSchema>;
}

/**
 * Parse the optimistic-concurrency precondition from the `If-Match` header
 * (RFC 9110). Accepts a bare positive integer (`If-Match: 3`) or the quoted
 * strong-entity-tag form (`If-Match: "3"`). Returns undefined when the
 * header is absent; callers that require a precondition reject the request
 * when no version was supplied by any channel.
 */
export function parseIfMatchHeader(request: FastifyRequest): number | undefined {
  const raw = request.headers["if-match"];
  if (raw === undefined) {
    return undefined;
  }
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const match = /^"(\d+)"$|^(\d+)$/u.exec(value);
  const parsed = match === null ? Number.NaN : Number(match[1] ?? match[2]);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new LumenError(
      "VALIDATION_FAILED",
      'If-Match header must be a positive integer resource version, for example: If-Match: "3".'
    );
  }
  return parsed;
}
