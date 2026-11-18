import { describe, expect, it, vi } from "vitest";

import { loadConfig, LumenError } from "@lumenbazaar/shared";
import { testAssetContractId, testPaymentRequest } from "@lumenbazaar/testkit";

import { parseVerifyPaymentRequest } from "./paymentPayload.js";
import {
  checkSettlementFeeCeiling,
  createSorobanSettlementFeeQuoter,
  feeCeilingExceededMessage,
  resolveEffectiveFeeCeiling,
  type EffectiveFeeCeiling,
  type FeeCeilingOverride,
  type SettlementFeeQuote
} from "./settlementFeeCeiling.js";

const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });
const normalizedRequest = parseVerifyPaymentRequest(testPaymentRequest, config);
const quoteInput = {
  paymentPayload: testPaymentRequest.paymentPayload,
  paymentRequirements: testPaymentRequest.paymentRequirements,
  normalizedRequest
} as Parameters<ReturnType<typeof createSorobanSettlementFeeQuoter>["quoteSettlementFee"]>[0];

function ceiling(ceilingStroops: number): EffectiveFeeCeiling {
  return { ceilingStroops, overridden: false };
}

function quote(feeStroops: number): SettlementFeeQuote {
  return { feeStroops, resourceFeeStroops: feeStroops - 100, inclusionFeeStroops: 100 };
}

describe("resolveEffectiveFeeCeiling", () => {
  it("uses the configured ceiling when no override is supplied", () => {
    expect(resolveEffectiveFeeCeiling(config)).toEqual({
      ceilingStroops: 50_000,
      overridden: false
    });
  });

  it("denies overrides by default", () => {
    expect(config.settlement.feeCeilingOverrideEnabled).toBe(false);
    expect(() =>
      resolveEffectiveFeeCeiling(config, {
        ceilingStroops: 60_000,
        operatorId: "op-1",
        reason: "fees spiked"
      })
    ).toThrowError(LumenError);
    expect(() =>
      resolveEffectiveFeeCeiling(config, {
        ceilingStroops: 60_000,
        operatorId: "op-1",
        reason: "fees spiked"
      })
    ).toThrow("overrides are disabled");
  });

  it("honours an explicit override when overrides are enabled", () => {
    const enabled = loadConfig({
      STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId,
      STELLAR_FEE_CEILING_STROOPS: "50000",
      STELLAR_MAX_TRANSACTION_FEE_STROOPS: "100000",
      STELLAR_FEE_CEILING_OVERRIDE_ENABLED: "true"
    });
    expect(
      resolveEffectiveFeeCeiling(enabled, {
        ceilingStroops: 60_000,
        operatorId: "op-1",
        reason: "fees spiked"
      })
    ).toEqual({
      ceilingStroops: 60_000,
      overridden: true,
      override: { ceilingStroops: 60_000, operatorId: "op-1", reason: "fees spiked" }
    });
  });

  it.each([
    [{ ceilingStroops: 50_000, operatorId: "op-1", reason: "no raise" }, "must raise the ceiling"],
    [{ ceilingStroops: 40_000, operatorId: "op-1", reason: "lower" }, "must raise the ceiling"],
    [{ ceilingStroops: 60_000, operatorId: "", reason: "no operator" }, "operatorId and a reason"],
    [{ ceilingStroops: 60_000, operatorId: "op-1", reason: "   " }, "operatorId and a reason"],
    [
      { ceilingStroops: 100_001, operatorId: "op-1", reason: "too high" },
      "must not exceed the maximum"
    ]
  ] as Array<[FeeCeilingOverride, string]>)("rejects an override of %s", (override, message) => {
    const enabled = loadConfig({
      STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId,
      STELLAR_FEE_CEILING_STROOPS: "50000",
      STELLAR_MAX_TRANSACTION_FEE_STROOPS: "100000",
      STELLAR_FEE_CEILING_OVERRIDE_ENABLED: "true"
    });
    expect(() => resolveEffectiveFeeCeiling(enabled, override)).toThrow(message);
  });

  it("rejects a non-integer override ceiling", () => {
    const enabled = loadConfig({
      STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId,
      STELLAR_FEE_CEILING_STROOPS: "50000",
      STELLAR_MAX_TRANSACTION_FEE_STROOPS: "100000",
      STELLAR_FEE_CEILING_OVERRIDE_ENABLED: "true"
    });
    expect(() =>
      resolveEffectiveFeeCeiling(enabled, {
        ceilingStroops: 60_000.5,
        operatorId: "op-1",
        reason: "fractional"
      })
    ).toThrow("positive integer");
  });
});

describe("checkSettlementFeeCeiling", () => {
  it("allows a fee at the ceiling", () => {
    expect(checkSettlementFeeCeiling({ quote: quote(50_000), ceiling: ceiling(50_000) })).toEqual({
      allowed: true,
      feeStroops: 50_000,
      ceilingStroops: 50_000,
      overridden: false
    });
  });

  it("blocks a fee one stroop above the ceiling", () => {
    expect(checkSettlementFeeCeiling({ quote: quote(50_001), ceiling: ceiling(50_000) })).toEqual({
      allowed: false,
      feeStroops: 50_001,
      ceilingStroops: 50_000,
      overridden: false
    });
  });

  it("carries an applied override through the decision", () => {
    const override = { ceilingStroops: 60_000, operatorId: "op-1", reason: "fees spiked" };
    expect(
      checkSettlementFeeCeiling({
        quote: quote(55_000),
        ceiling: { ceilingStroops: 60_000, overridden: true, override }
      })
    ).toEqual({
      allowed: true,
      feeStroops: 55_000,
      ceilingStroops: 60_000,
      overridden: true,
      override
    });
  });

  it("formats the exceeded message with fee and ceiling values", () => {
    expect(feeCeilingExceededMessage(60_000, 50_000)).toBe(
      "Settlement fee 60000 stroops exceeds the fee ceiling of 50000 stroops."
    );
  });
});

describe("createSorobanSettlementFeeQuoter", () => {
  it("derives the fee as minResourceFee plus the inclusion fee bid", async () => {
    const transport = vi.fn(async () => ({ minResourceFee: "12345" }));
    const quoter = createSorobanSettlementFeeQuoter(config, transport);

    await expect(quoter.quoteSettlementFee(quoteInput)).resolves.toEqual({
      feeStroops: 12_445,
      resourceFeeStroops: 12_345,
      inclusionFeeStroops: 100
    });
    expect(transport).toHaveBeenCalledWith({
      rpcUrl: config.networks["stellar:testnet"].rpcUrl,
      transactionXdr: testPaymentRequest.paymentPayload.payload.transaction
    });
  });

  it("fails closed when the simulation transport fails", async () => {
    const quoter = createSorobanSettlementFeeQuoter(config, async () => {
      throw new Error("rpc down");
    });

    await expect(quoter.quoteSettlementFee(quoteInput)).rejects.toMatchObject({
      code: "SETTLEMENT_FAILED",
      details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" }
    });
  });

  it("fails closed on a malformed resource fee", async () => {
    const quoter = createSorobanSettlementFeeQuoter(config, async () => ({
      minResourceFee: "not-a-number"
    }));

    await expect(quoter.quoteSettlementFee(quoteInput)).rejects.toMatchObject({
      code: "SETTLEMENT_FAILED",
      details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" }
    });
  });

  it("fails closed for an unconfigured network", async () => {
    const quoter = createSorobanSettlementFeeQuoter(config, async () => ({
      minResourceFee: "100"
    }));
    const unknownNetwork = {
      ...quoteInput,
      normalizedRequest: { ...normalizedRequest, network: "stellar:futurenet" }
    } as unknown as Parameters<
      ReturnType<typeof createSorobanSettlementFeeQuoter>["quoteSettlementFee"]
    >[0];

    await expect(quoter.quoteSettlementFee(unknownNetwork)).rejects.toMatchObject({
      code: "UNSUPPORTED_NETWORK"
    });
  });

  it("quotes through the default fetch transport", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { minResourceFee: "777" } })
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const quoter = createSorobanSettlementFeeQuoter(config);

      await expect(quoter.quoteSettlementFee(quoteInput)).resolves.toEqual({
        feeStroops: 877,
        resourceFeeStroops: 777,
        inclusionFeeStroops: 100
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(config.networks["stellar:testnet"].rpcUrl);
      expect(JSON.parse(String(init.body))).toMatchObject({
        method: "simulateTransaction",
        params: { transaction: testPaymentRequest.paymentPayload.payload.transaction }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when the default transport receives a simulation error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ result: { error: "simulation failed" } })
      }))
    );
    try {
      const quoter = createSorobanSettlementFeeQuoter(config);
      await expect(quoter.quoteSettlementFee(quoteInput)).rejects.toMatchObject({
        code: "SETTLEMENT_FAILED",
        details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
