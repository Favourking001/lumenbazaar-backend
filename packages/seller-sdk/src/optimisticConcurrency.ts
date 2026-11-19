/**
 * Optimistic concurrency for resource updates (issue #102).
 *
 * Every resource update, delete (soft-delete), and rollback requires the
 * caller to send the resource `version` it read. The backend applies the
 * mutation only while the stored version still matches, increments it
 * atomically, and rejects a stale write with 409 RESOURCE_VERSION_CONFLICT
 * (details carry `expectedVersion` and `currentVersion`, so the caller can
 * re-read and retry). Use these helpers to send the precondition the same
 * way the API expects it.
 */

export function assertExpectedVersion(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Expected resource version must be a positive integer.");
  }
}

/**
 * Build the `If-Match` header for a resource mutation, from the version the
 * caller read (for example `resource.version` from a GET response).
 */
export function ifMatchHeader(expectedVersion: number): { "If-Match": string } {
  assertExpectedVersion(expectedVersion);
  return { "If-Match": `"${expectedVersion}"` };
}

/**
 * Parse an `If-Match` header value back to a version number. Accepts the
 * quoted form (`"3"`) and the bare form (`3`). Returns undefined for a
 * missing header and throws for a malformed one.
 */
export function parseIfMatchHeader(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const match = /^"(\d+)"$|^(\d+)$/u.exec(trimmed);
  const parsed = match === null ? Number.NaN : Number(match[1] ?? match[2]);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      'If-Match header must be a positive integer resource version, for example: If-Match: "3".'
    );
  }
  return parsed;
}

/**
 * Attach the expected version to an update body. The API also accepts the
 * `If-Match` header; the header wins when both are sent.
 */
export function withExpectedVersion<T extends object>(
  body: T,
  expectedVersion: number
): T & { version: number } {
  assertExpectedVersion(expectedVersion);
  return { ...body, version: expectedVersion };
}

/** True when an API error body is a stale-write conflict (HTTP 409). */
export function isResourceVersionConflict(error: { code?: string; statusCode?: number }): boolean {
  return error.code === "RESOURCE_VERSION_CONFLICT" || error.statusCode === 409;
}
