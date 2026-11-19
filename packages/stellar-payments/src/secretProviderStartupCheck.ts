/**
 * Startup secret-provider health checks (issue #113).
 *
 * Services must not start with syntactically present but unusable signer or
 * webhook/event-stream key references. These checks validate, before the API
 * (or any worker) serves traffic, that each configured secret provider is
 * reachable, that the referenced keys exist and carry the required
 * metadata/permissions — without signing any production payload and without
 * logging any secret material.
 *
 * What a check does, per capability:
 * - `facilitator_signer` — calls the signer provider's `assertReady()` and
 *   `getStatus()` (reachability, key existence, address/network match, active
 *   state). It never calls `sign()`: no payload, production or otherwise, is
 *   signed by the check.
 * - `event_stream_signing` — HMAC-signs and verifies a fixed synthetic
 *   sentinel string with the configured event-stream signing secret. The
 *   sentinel is not a production payload and the secret itself is never
 *   returned or logged; only a truncated SHA-256 fingerprint identifies it.
 *
 * Failure semantics (fail closed, per capability):
 * - A failed check blocks only the capability that requires that secret. The
 *   caller drops the affected provider (for example, the facilitator signer)
 *   so the scheme is not advertised, while unrelated services still start.
 * - Every result carries a stable reason code only. Raw provider errors,
 *   hostnames, connection strings, key material and signed payloads are never
 *   included in results or log lines; key identifiers are public references
 *   (configured key version / KMS key id / truncated fingerprint) and are
 *   passed through `redactSensitiveText` as defence in depth before logging.
 *
 * Checks are bounded by a per-probe timeout (default 5 000 ms) and run in
 * parallel, so they never block unrelated startup work.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { redactSensitiveText, type AppConfig } from "@lumenbazaar/shared";

import { type FacilitatorSignerProvider, type SignerStatus } from "./facilitatorSigner.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Capabilities gated on a secret provider. Extend here if a new
 * secret-backed capability is added.
 */
export type SecretProviderCapability = "facilitator_signer" | "event_stream_signing";

/**
 * Stable reason codes surfaced in startup diagnostics and readiness output.
 * Never includes raw provider errors, secrets, keys, or signed payloads.
 *
 * - provider_not_configured — the capability requires a secret provider but
 *   none was configured (or its adapter is not wired); capability cannot be
 *   served
 * - provider_unreachable   — the provider could not be reached (network /
 *   connection failure)
 * - key_not_found          — the referenced key does not exist or its material
 *   is unavailable
 * - insufficient_permissions — the provider denied the operation; the
 *   configured identity lacks a required permission
 * - key_metadata_invalid   — the key exists but its metadata does not match
 *   configuration (wrong address, network, or non-active state)
 * - check_timeout          — the check did not complete within the deadline
 * - check_failed           — the check threw an unclassified error
 */
export type SecretProviderCheckReason =
  | "provider_not_configured"
  | "provider_unreachable"
  | "key_not_found"
  | "insufficient_permissions"
  | "key_metadata_invalid"
  | "check_timeout"
  | "check_failed";

export type SecretProviderCheckResult =
  | {
      ok: true;
      capability: SecretProviderCapability;
      provider: string;
      /** Public key identifier only (key version, KMS key id, or fingerprint). */
      keyId: string;
      latencyMs: number;
    }
  | {
      ok: false;
      capability: SecretProviderCapability;
      provider: string;
      /** Public key identifier only (key version, KMS key id, or fingerprint). */
      keyId: string;
      reason: SecretProviderCheckReason;
      latencyMs: number;
    };

export type SecretProviderStartupReport = {
  results: ReadonlyArray<SecretProviderCheckResult>;
  /** True only when every configured provider check passed. */
  allOk: boolean;
  /** Capabilities whose secret-provider check failed (fail closed). */
  blockedCapabilities: ReadonlyArray<SecretProviderCapability>;
};

export type SecretProviderCheckOptions = {
  /**
   * Maximum milliseconds to wait for a single provider check.
   * Defaults to 5 000 ms.
   */
  timeoutMs?: number;
};

/**
 * A secret provider health probe.
 *
 * Implementations (including the in-memory fakes used in tests) must:
 * - validate reachability, key existence/metadata and required permissions;
 * - never sign a production payload;
 * - never return or log secret material — `keyId` must be a public
 *   identifier (configured key version, KMS key id, or truncated fingerprint);
 * - return a stable reason code on failure instead of throwing raw errors
 *   (thrown errors are classified as `check_failed` and their text is dropped).
 */
export type SecretProviderHealthProbe = {
  readonly capability: SecretProviderCapability;
  /** Provider identifier, e.g. "environment" or "kms". */
  readonly provider: string;
  /** Public key identifier only — never secret material. */
  readonly keyId: string;
  /** Permissions the check exercises, e.g. ["kms:DescribeKey", "kms:GetPublicKey"]. */
  readonly requiredPermissions: ReadonlyArray<string>;
  /**
   * Run the health validation. Resolves `{ ok: true }` (optionally with the
   * live public key id, when it differs from the configured `keyId`) or
   * `{ ok: false, reason }`. Must not sign production payloads.
   */
  checkHealth(): Promise<
    { ok: true; keyId?: string } | { ok: false; reason: SecretProviderCheckReason }
  >;
};

// ─── Check runner ─────────────────────────────────────────────────────────────

/**
 * Run one provider check with a bounded timeout.
 *
 * A probe that returns `{ ok: false, reason }` keeps its reason. A probe that
 * throws is classified from its error code/name (permission, not-found,
 * network, timeout) and otherwise reported as `check_failed` — the raw error
 * text is never surfaced.
 */
export async function checkSecretProvider(
  probe: SecretProviderHealthProbe,
  options: SecretProviderCheckOptions = {}
): Promise<SecretProviderCheckResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const start = Date.now();

  try {
    const outcome = await raceTimeout(() => probe.checkHealth(), timeoutMs);
    const latencyMs = Date.now() - start;
    if (outcome === "timeout") {
      return {
        ok: false,
        capability: probe.capability,
        provider: probe.provider,
        keyId: probe.keyId,
        reason: "check_timeout",
        latencyMs
      };
    }
    if (outcome.ok) {
      return {
        ok: true,
        capability: probe.capability,
        provider: probe.provider,
        keyId: outcome.keyId ?? probe.keyId,
        latencyMs
      };
    }
    return {
      ok: false,
      capability: probe.capability,
      provider: probe.provider,
      keyId: probe.keyId,
      reason: outcome.reason,
      latencyMs
    };
  } catch (error) {
    return {
      ok: false,
      capability: probe.capability,
      provider: probe.provider,
      keyId: probe.keyId,
      reason: classifySecretProviderError(error),
      latencyMs: Date.now() - start
    };
  }
}

/**
 * Run all configured provider checks in parallel.
 *
 * This function always resolves — a failed or timed-out check records its
 * reason and lists the capability in `blockedCapabilities` instead of
 * throwing, so the caller can fail closed per capability while unrelated
 * services still start.
 */
export async function runSecretProviderStartupChecks(
  probes: ReadonlyArray<SecretProviderHealthProbe>,
  options: SecretProviderCheckOptions = {}
): Promise<SecretProviderStartupReport> {
  const results = await Promise.all(probes.map((probe) => checkSecretProvider(probe, options)));
  const blockedCapabilities = results
    .filter((result): result is Extract<SecretProviderCheckResult, { ok: false }> => !result.ok)
    .map((result) => result.capability);

  return {
    results: Object.freeze(results),
    allOk: blockedCapabilities.length === 0,
    blockedCapabilities: Object.freeze(blockedCapabilities)
  };
}

/**
 * Build a redacted structured log line for a check result.
 *
 * Only the capability, provider, public key identifier, outcome, stable
 * reason code and latency are emitted. The key identifier is passed through
 * `redactSensitiveText` as defence in depth in case a probe ever supplies a
 * value that looks like secret material.
 */
export function formatSecretProviderCheckLog(
  result: SecretProviderCheckResult
): Record<string, unknown> {
  const redactedKeyId = redactSensitiveText(result.keyId);
  return {
    event: "secret_provider_startup_check",
    capability: result.capability,
    provider: result.provider,
    keyId: redactedKeyId,
    ok: result.ok,
    ...(result.ok ? {} : { reason: result.reason }),
    latencyMs: result.latencyMs
  };
}

// ─── Facilitator signer probe ─────────────────────────────────────────────────

/**
 * Permissions exercised by the facilitator signer check against a KMS
 * provider: reading the key identity and address (no signing — the check
 * never calls `sign()`).
 */
export const kmsFacilitatorSignerRequiredPermissions = Object.freeze([
  "kms:DescribeKey",
  "kms:GetPublicKey"
] as const);

/**
 * Build a secret-provider probe for the facilitator signer.
 *
 * The probe calls `assertReady()` (provider reachability + key availability)
 * and `getStatus()` (address / network / active-state metadata match). It
 * never calls `sign()`, so no payload — production or otherwise — is signed.
 *
 * When `provider` is undefined but the config requires a signer, the probe
 * reports `provider_not_configured` (this covers the KMS case where the
 * adapter is not wired: the runtime provider factory fails closed instead of
 * silently falling back to environment signing).
 */
export function createFacilitatorSignerSecretProbe(
  provider: FacilitatorSignerProvider | undefined,
  config: AppConfig
): SecretProviderHealthProbe {
  const configuredKeyId = config.signer.keyVersion ?? config.signer.kms?.keyId ?? "unknown";
  const providerId = config.signer.provider;

  if (provider === undefined) {
    return {
      capability: "facilitator_signer",
      provider: providerId,
      keyId: configuredKeyId,
      requiredPermissions: providerId === "kms" ? [...kmsFacilitatorSignerRequiredPermissions] : [],
      async checkHealth() {
        return { ok: false, reason: "provider_not_configured" };
      }
    };
  }

  return {
    capability: "facilitator_signer",
    provider: providerId,
    keyId: configuredKeyId,
    requiredPermissions: providerId === "kms" ? [...kmsFacilitatorSignerRequiredPermissions] : [],
    async checkHealth() {
      await provider.assertReady();
      const status: SignerStatus = await provider.getStatus();
      if (status.state !== "active") {
        return { ok: false, reason: "key_metadata_invalid" };
      }
      if (status.address !== config.facilitatorAccount) {
        return { ok: false, reason: "key_metadata_invalid" };
      }
      if (status.network !== config.signer.network) {
        return { ok: false, reason: "key_metadata_invalid" };
      }
      return { ok: true, keyId: status.keyId };
    }
  };
}

// ─── Event-stream signing secret probe ────────────────────────────────────────

/** Fixed synthetic sentinel — never a production payload. */
const eventStreamSigningSentinel =
  "lumenbazaar:secret-provider-startup-check:v1:event-stream-signing";

/**
 * Build a secret-provider probe for the event-stream signing secret
 * (`EVENT_STREAM_SIGNING_SECRET`).
 *
 * The probe HMAC-signs the fixed synthetic sentinel and verifies the MAC
 * round-trips. No production payload is signed and the secret itself is never
 * returned or logged; `keyId` is a truncated SHA-256 fingerprint of the
 * secret (`sha256:<first 12 hex chars>`).
 *
 * A local HMAC secret has no external permission model, so
 * `requiredPermissions` is empty: the check validates presence and usability
 * instead.
 */
export function createEventStreamSigningSecretProbe(
  signingSecret: string | undefined
): SecretProviderHealthProbe {
  const fingerprint =
    signingSecret === undefined || signingSecret.length === 0
      ? "unknown"
      : eventStreamSecretFingerprint(signingSecret);

  return {
    capability: "event_stream_signing",
    provider: "environment",
    keyId: fingerprint,
    requiredPermissions: [],
    async checkHealth() {
      if (signingSecret === undefined || signingSecret.length === 0) {
        return { ok: false, reason: "provider_not_configured" };
      }
      // Synthetic sign + verify only: proves the secret is present and usable
      // for HMAC without touching any production payload.
      const mac = createHmac("sha256", signingSecret)
        .update(eventStreamSigningSentinel, "utf8")
        .digest();
      const expected = createHmac("sha256", signingSecret)
        .update(eventStreamSigningSentinel, "utf8")
        .digest();
      if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
        return { ok: false, reason: "key_metadata_invalid" };
      }
      return { ok: true, keyId: fingerprint };
    }
  };
}

export function eventStreamSecretFingerprint(signingSecret: string): string {
  return `sha256:${createHash("sha256").update(signingSecret, "utf8").digest("hex").slice(0, 12)}`;
}

// ─── Error classification ─────────────────────────────────────────────────────

/**
 * Map a thrown error to a stable reason code.
 *
 * Classification uses the error `code`/`name` first (provider SDK error
 * codes such as `AccessDeniedException` or `NotFoundException`), then the
 * stable messages produced by this repo's own signer providers, then generic
 * network/timeout signals. The raw error text is never returned.
 */
export function classifySecretProviderError(error: unknown): SecretProviderCheckReason {
  const code = extractErrorCode(error);
  if (code !== undefined) {
    if (permissionDeniedCodes.has(code)) {
      return "insufficient_permissions";
    }
    if (notFoundCodes.has(code)) {
      return "key_not_found";
    }
    if (timeoutCodes.has(code)) {
      return "check_timeout";
    }
    if (networkCodes.has(code)) {
      return "provider_unreachable";
    }
  }

  const message = error instanceof Error ? error.message : "";
  if (/permission denied|access denied|forbidden/i.test(message)) {
    return "insufficient_permissions";
  }
  if (/address does not match|not in the active state|signing material is invalid/i.test(message)) {
    return "key_metadata_invalid";
  }
  if (
    /signing material is unavailable|key id is unavailable|address is unavailable/i.test(message)
  ) {
    return "key_not_found";
  }
  if (/timed out|timeout/i.test(message)) {
    return "check_timeout";
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network/i.test(message)) {
    return "provider_unreachable";
  }
  return "check_failed";
}

const permissionDeniedCodes = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "PermissionDenied",
  "Forbidden",
  "Unauthorized",
  "UnauthorizedException"
]);

const notFoundCodes = new Set([
  "NotFound",
  "NotFoundException",
  "NoSuchKey",
  "KeyNotFound",
  "ResourceNotFoundException"
]);

const timeoutCodes = new Set(["TimeoutError", "RequestTimeout", "ThrottlingException", "Timeout"]);

const networkCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "EPIPE",
  "FetchError"
]);

function extractErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { name?: unknown; code?: unknown };
    if (typeof candidate.code === "string") {
      return candidate.code;
    }
    if (typeof candidate.name === "string") {
      return candidate.name;
    }
  }
  return undefined;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Race an async operation against a wall-clock timeout.
 * Returns `"timeout"` if the timer fires first. Raw errors from `fn` are
 * re-thrown so the caller can classify them.
 */
async function raceTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return new Promise<T | "timeout">((resolve, reject) => {
    const id = setTimeout(() => resolve("timeout"), timeoutMs);

    if (typeof id === "object" && "unref" in id) {
      (id as NodeJS.Timeout).unref();
    }

    fn().then(
      (value) => {
        clearTimeout(id);
        resolve(value);
      },
      (err) => {
        clearTimeout(id);
        reject(err);
      }
    );
  });
}
