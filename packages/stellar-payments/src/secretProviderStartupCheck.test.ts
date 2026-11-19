import { describe, expect, it } from "vitest";

import { loadConfig } from "@lumenbazaar/shared";

import {
  checkSecretProvider,
  classifySecretProviderError,
  createEventStreamSigningSecretProbe,
  createFacilitatorSignerSecretProbe,
  eventStreamSecretFingerprint,
  formatSecretProviderCheckLog,
  kmsFacilitatorSignerRequiredPermissions,
  runSecretProviderStartupChecks,
  type SecretProviderHealthProbe
} from "./secretProviderStartupCheck.js";
import { type FacilitatorSignerProvider, type SignerStatus } from "./facilitatorSigner.js";

// ─── Fakes ────────────────────────────────────────────────────────────────────

/** Sentinel Stellar public key (not a real key). */
const sentinelAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Clearly fake secret material — never a real key. Used only to prove logs stay clean. */
const fakeSecretSeed = `S${"A".repeat(55)}`;
const fakeHmacSecret = "fake-hmac-signing-secret-do-not-use";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function healthyProbe(
  capability: SecretProviderHealthProbe["capability"] = "facilitator_signer"
): SecretProviderHealthProbe {
  return {
    capability,
    provider: "environment",
    keyId: "v1:abcd1234",
    requiredPermissions: [],
    async checkHealth() {
      return { ok: true };
    }
  };
}

function failingProbe(
  capability: SecretProviderHealthProbe["capability"],
  reason: "provider_unreachable" | "key_not_found" | "insufficient_permissions"
): SecretProviderHealthProbe {
  return {
    capability,
    provider: "kms",
    keyId: "arn:aws:kms:us-east-1:000000000000:key/fake-key-id",
    requiredPermissions: ["kms:DescribeKey", "kms:GetPublicKey"],
    async checkHealth() {
      return { ok: false, reason };
    }
  };
}

function throwingProbe(error: Error): SecretProviderHealthProbe {
  return {
    capability: "facilitator_signer",
    provider: "kms",
    keyId: "fake-key-id",
    requiredPermissions: ["kms:DescribeKey"],
    async checkHealth() {
      throw error;
    }
  };
}

function hangingProbe(): SecretProviderHealthProbe {
  return {
    capability: "event_stream_signing",
    provider: "environment",
    keyId: "sha256:deadbeef0000",
    requiredPermissions: [],
    async checkHealth() {
      await sleep(500);
      return { ok: true };
    }
  };
}

function codedError(code: string, message = "provider failure"): Error {
  return Object.assign(new Error(message), { code });
}

function fakeSignerProvider(overrides: {
  assertReady?: () => Promise<void>;
  getStatus?: () => Promise<SignerStatus>;
  getSigner?: () => Promise<never>;
}): FacilitatorSignerProvider {
  return {
    async assertReady() {
      if (overrides.assertReady !== undefined) {
        await overrides.assertReady();
      }
    },
    async getSigner() {
      if (overrides.getSigner !== undefined) {
        return overrides.getSigner();
      }
      throw new Error("getSigner must not be called by a startup secret-provider check");
    },
    async getSignerByKeyId() {
      throw new Error("getSignerByKeyId must not be called by a startup secret-provider check");
    },
    async getStatus() {
      if (overrides.getStatus !== undefined) {
        return overrides.getStatus();
      }
      return {
        address: sentinelAddress,
        keyVersion: "v1",
        keyId: "v1:abcd1234",
        state: "active",
        network: "stellar:testnet",
        provider: "environment"
      };
    },
    async getAuditEvents() {
      return [];
    }
  } as unknown as FacilitatorSignerProvider;
}

// ─── checkSecretProvider ──────────────────────────────────────────────────────

describe("checkSecretProvider – pass", () => {
  it("returns ok:true with the public key id when the provider is reachable and permitted", async () => {
    const result = await checkSecretProvider(healthyProbe());
    expect(result).toEqual({
      ok: true,
      capability: "facilitator_signer",
      provider: "environment",
      keyId: "v1:abcd1234",
      latencyMs: expect.any(Number)
    });
  });
});

describe("checkSecretProvider – provider_unreachable", () => {
  it("returns provider_unreachable when the provider cannot be reached", async () => {
    const result = await checkSecretProvider(
      throwingProbe(codedError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:443"))
    );
    expect(result).toEqual({
      ok: false,
      capability: "facilitator_signer",
      provider: "kms",
      keyId: "fake-key-id",
      reason: "provider_unreachable",
      latencyMs: expect.any(Number)
    });
  });
});

describe("checkSecretProvider – key_not_found", () => {
  it("returns key_not_found when the referenced key does not exist", async () => {
    const result = await checkSecretProvider(
      throwingProbe(codedError("NotFoundException", "key fake-key-id not found"))
    );
    expect(result).toEqual({
      ok: false,
      capability: "facilitator_signer",
      provider: "kms",
      keyId: "fake-key-id",
      reason: "key_not_found",
      latencyMs: expect.any(Number)
    });
  });
});

describe("checkSecretProvider – insufficient_permissions", () => {
  it("returns insufficient_permissions when the provider denies the operation", async () => {
    const result = await checkSecretProvider(
      throwingProbe(
        codedError("AccessDeniedException", "user is not authorized to perform kms:DescribeKey")
      )
    );
    expect(result).toEqual({
      ok: false,
      capability: "facilitator_signer",
      provider: "kms",
      keyId: "fake-key-id",
      reason: "insufficient_permissions",
      latencyMs: expect.any(Number)
    });
  });
});

describe("checkSecretProvider – check_timeout", () => {
  it("returns check_timeout when the probe exceeds the deadline", async () => {
    const result = await checkSecretProvider(hangingProbe(), { timeoutMs: 5 });
    expect(result).toEqual({
      ok: false,
      capability: "event_stream_signing",
      provider: "environment",
      keyId: "sha256:deadbeef0000",
      reason: "check_timeout",
      latencyMs: expect.any(Number)
    });
  });
});

describe("checkSecretProvider – check_failed and redaction", () => {
  it("returns check_failed for unclassified errors and never surfaces secret material", async () => {
    const result = await checkSecretProvider(
      throwingProbe(new Error(`unexpected failure with secret ${fakeSecretSeed}`))
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("check_failed");
    }
    expect(JSON.stringify(result)).not.toContain(fakeSecretSeed);
    expect(JSON.stringify(result)).not.toContain("unexpected failure");
  });

  it("keeps a probe-reported reason code instead of reclassifying it", async () => {
    const result = await checkSecretProvider(failingProbe("facilitator_signer", "key_not_found"));
    expect(result).toEqual({
      ok: false,
      capability: "facilitator_signer",
      provider: "kms",
      keyId: "arn:aws:kms:us-east-1:000000000000:key/fake-key-id",
      reason: "key_not_found",
      latencyMs: expect.any(Number)
    });
  });
});

// ─── classifySecretProviderError ──────────────────────────────────────────────

describe("classifySecretProviderError", () => {
  it.each([
    ["AccessDeniedException", "insufficient_permissions"],
    ["PermissionDenied", "insufficient_permissions"],
    ["NotFoundException", "key_not_found"],
    ["NoSuchKey", "key_not_found"],
    ["TimeoutError", "check_timeout"],
    ["ECONNREFUSED", "provider_unreachable"],
    ["ENOTFOUND", "provider_unreachable"]
  ] as const)("maps code %s to %s", (code, expected) => {
    expect(classifySecretProviderError(codedError(code))).toBe(expected);
  });

  it("maps the repo's own signer messages without leaking them", () => {
    expect(classifySecretProviderError(new Error("KMS permission denied."))).toBe(
      "insufficient_permissions"
    );
    expect(
      classifySecretProviderError(new Error("Facilitator signing material is unavailable."))
    ).toBe("key_not_found");
    expect(
      classifySecretProviderError(
        new Error("Facilitator signer address does not match configuration.")
      )
    ).toBe("key_metadata_invalid");
    expect(classifySecretProviderError(new Error("something entirely new"))).toBe("check_failed");
  });
});

// ─── runSecretProviderStartupChecks ───────────────────────────────────────────

describe("runSecretProviderStartupChecks", () => {
  it("passes when every probe passes", async () => {
    const report = await runSecretProviderStartupChecks([
      healthyProbe("facilitator_signer"),
      healthyProbe("event_stream_signing")
    ]);
    expect(report.allOk).toBe(true);
    expect(report.blockedCapabilities).toEqual([]);
    expect(report.results).toHaveLength(2);
  });

  it("fails closed per capability: one failure does not affect the other", async () => {
    const report = await runSecretProviderStartupChecks([
      failingProbe("facilitator_signer", "insufficient_permissions"),
      healthyProbe("event_stream_signing")
    ]);
    expect(report.allOk).toBe(false);
    expect(report.blockedCapabilities).toEqual(["facilitator_signer"]);
    expect(report.results[0]).toMatchObject({
      ok: false,
      capability: "facilitator_signer",
      reason: "insufficient_permissions"
    });
    expect(report.results[1]).toMatchObject({ ok: true, capability: "event_stream_signing" });
  });

  it("resolves with an empty report when no secret providers are configured", async () => {
    const report = await runSecretProviderStartupChecks([]);
    expect(report).toEqual({ results: [], allOk: true, blockedCapabilities: [] });
  });

  it("never includes secret material in any result, even when probes throw it", async () => {
    const report = await runSecretProviderStartupChecks([
      throwingProbe(new Error(`kms blew up with ${fakeSecretSeed}`)),
      throwingProbe(new Error(`hmac secret is ${fakeHmacSecret}`))
    ]);
    expect(JSON.stringify(report)).not.toContain(fakeSecretSeed);
    expect(JSON.stringify(report)).not.toContain(fakeHmacSecret);
    expect(report.allOk).toBe(false);
  });
});

// ─── formatSecretProviderCheckLog ─────────────────────────────────────────────

describe("formatSecretProviderCheckLog", () => {
  it("emits only capability, provider, public key id, outcome, reason and latency", async () => {
    const result = await checkSecretProvider(
      failingProbe("facilitator_signer", "insufficient_permissions")
    );
    const line = formatSecretProviderCheckLog(result);
    expect(line).toEqual({
      event: "secret_provider_startup_check",
      capability: "facilitator_signer",
      provider: "kms",
      keyId: "arn:aws:kms:us-east-1:000000000000:key/fake-key-id",
      ok: false,
      reason: "insufficient_permissions",
      latencyMs: expect.any(Number)
    });
    // The event name itself contains "secret_provider", so assert against
    // actual secret *material* instead of the word "secret".
    expect(JSON.stringify(line)).not.toContain(fakeSecretSeed);
    expect(JSON.stringify(line)).not.toContain(fakeHmacSecret);
  });

  it("redacts a key id that looks like secret material (defence in depth)", () => {
    const line = formatSecretProviderCheckLog({
      ok: true,
      capability: "facilitator_signer",
      provider: "environment",
      keyId: fakeSecretSeed,
      latencyMs: 1
    });
    expect(JSON.stringify(line)).not.toContain(fakeSecretSeed);
    expect(line.keyId).toBe("[redacted]");
  });
});

// ─── createFacilitatorSignerSecretProbe ───────────────────────────────────────

describe("createFacilitatorSignerSecretProbe", () => {
  const config = loadConfig({
    LUMEN_ENV: "local",
    FACILITATOR_ACCOUNT: sentinelAddress,
    FACILITATOR_SIGNER_PROVIDER: "environment",
    FACILITATOR_SIGNING_KEY_VERSION: "v1"
  });

  it("passes when the provider is ready and the live key matches configuration", async () => {
    const probe = createFacilitatorSignerSecretProbe(fakeSignerProvider({}), config);
    expect(probe.capability).toBe("facilitator_signer");
    expect(probe.provider).toBe("environment");
    expect(probe.keyId).toBe("v1");
    expect(probe.requiredPermissions).toEqual([]);

    const result = await checkSecretProvider(probe);
    expect(result).toEqual({
      ok: true,
      capability: "facilitator_signer",
      provider: "environment",
      keyId: "v1:abcd1234",
      latencyMs: expect.any(Number)
    });
  });

  it("never resolves a signer: getSigner is not called, so nothing is signed", async () => {
    const probe = createFacilitatorSignerSecretProbe(
      fakeSignerProvider({
        async getSigner() {
          throw new Error("signing path invoked");
        }
      }),
      config
    );
    const result = await checkSecretProvider(probe);
    expect(result.ok).toBe(true);
  });

  it("fails with insufficient_permissions when the provider denies access", async () => {
    const probe = createFacilitatorSignerSecretProbe(
      fakeSignerProvider({
        async assertReady() {
          throw codedError("AccessDeniedException", "not authorized for kms:DescribeKey");
        }
      }),
      config
    );
    const result = await checkSecretProvider(probe);
    expect(result).toMatchObject({ ok: false, reason: "insufficient_permissions" });
  });

  it("fails with key_metadata_invalid when the signer is not active", async () => {
    const probe = createFacilitatorSignerSecretProbe(
      fakeSignerProvider({
        async getStatus() {
          return {
            address: sentinelAddress,
            keyVersion: "v1",
            keyId: "v1:abcd1234",
            state: "revoked",
            network: "stellar:testnet",
            provider: "environment"
          };
        }
      }),
      config
    );
    const result = await checkSecretProvider(probe);
    expect(result).toMatchObject({ ok: false, reason: "key_metadata_invalid" });
  });

  it("fails with key_metadata_invalid when the live address does not match configuration", async () => {
    const probe = createFacilitatorSignerSecretProbe(
      fakeSignerProvider({
        async getStatus() {
          return {
            address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            keyVersion: "v1",
            keyId: "v1:abcd1234",
            state: "active",
            network: "stellar:testnet",
            provider: "environment"
          };
        }
      }),
      config
    );
    const result = await checkSecretProvider(probe);
    expect(result).toMatchObject({ ok: false, reason: "key_metadata_invalid" });
  });

  it("fails with provider_not_configured when no signer provider is wired", async () => {
    const probe = createFacilitatorSignerSecretProbe(undefined, config);
    const result = await checkSecretProvider(probe);
    expect(result).toMatchObject({ ok: false, reason: "provider_not_configured" });
  });

  it("declares the KMS permissions the check exercises for a KMS signer", () => {
    const kmsConfig = loadConfig({
      LUMEN_ENV: "local",
      FACILITATOR_ACCOUNT: sentinelAddress,
      FACILITATOR_SIGNER_PROVIDER: "kms",
      FACILITATOR_KMS_PROVIDER: "aws-kms",
      FACILITATOR_KMS_KEY_ID: "arn:aws:kms:us-east-1:000000000000:key/fake-key-id"
    });
    const probe = createFacilitatorSignerSecretProbe(fakeSignerProvider({}), kmsConfig);
    expect(probe.provider).toBe("kms");
    expect(probe.keyId).toBe("arn:aws:kms:us-east-1:000000000000:key/fake-key-id");
    expect(probe.requiredPermissions).toEqual([...kmsFacilitatorSignerRequiredPermissions]);
  });
});

// ─── createEventStreamSigningSecretProbe ──────────────────────────────────────

describe("createEventStreamSigningSecretProbe", () => {
  it("fails with provider_not_configured when no signing secret is configured", async () => {
    const probe = createEventStreamSigningSecretProbe(undefined);
    expect(probe.keyId).toBe("unknown");
    const result = await checkSecretProvider(probe);
    expect(result).toMatchObject({ ok: false, reason: "provider_not_configured" });
  });

  it("fails with provider_not_configured for an empty secret", async () => {
    const result = await checkSecretProvider(createEventStreamSigningSecretProbe(""));
    expect(result).toMatchObject({ ok: false, reason: "provider_not_configured" });
  });

  it("passes for a usable secret and identifies it only by fingerprint", async () => {
    const probe = createEventStreamSigningSecretProbe(fakeHmacSecret);
    expect(probe.keyId).toBe(eventStreamSecretFingerprint(fakeHmacSecret));
    expect(probe.keyId.startsWith("sha256:")).toBe(true);
    expect(probe.keyId).not.toContain(fakeHmacSecret);
    expect(probe.requiredPermissions).toEqual([]);

    const result = await checkSecretProvider(probe);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyId).toBe(probe.keyId);
    }
    const logLine = formatSecretProviderCheckLog(result);
    expect(JSON.stringify(logLine)).not.toContain(fakeHmacSecret);
  });
});
