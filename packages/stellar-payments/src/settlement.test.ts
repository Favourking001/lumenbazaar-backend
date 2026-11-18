import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "@lumenbazaar/shared";
import {
  stubQuoteSettlementFee,
  testAssetContractId,
  testPaymentPayload,
  testPaymentRequest
} from "@lumenbazaar/testkit";

import {
  InMemoryPaymentAttemptStore,
  InMemorySettlementStore,
  PaymentVerificationService,
  ReceiptService,
  SettlementService,
  type PaymentAuditLogger,
  type X402StellarAdapter
} from "./index.js";

const adapter: X402StellarAdapter = {
  async verifyExact() {
    return {
      valid: true,
      adapter: "@x402/stellar"
    };
  },
  quoteSettlementFee: stubQuoteSettlementFee,
  async settleExact() {
    return {
      transactionHash: "tx_exact_123",
      ledger: 12345,
      status: "confirmed",
      adapter: "@x402/stellar"
    };
  }
};

describe("SettlementService", () => {
  it("settles a verified exact payment and stores transaction evidence", async () => {
    const attemptStore = new InMemoryPaymentAttemptStore();
    const settlementStore = new InMemorySettlementStore();
    const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });
    const verification = new PaymentVerificationService(config, { adapter, attemptStore });
    const settlement = new SettlementService(config, { adapter, attemptStore, settlementStore });
    const verified = await verification.verify(testPaymentRequest);

    await expect(
      settlement.settle({
        ...testPaymentRequest
      })
    ).resolves.toMatchObject({
      transactionHash: "tx_exact_123",
      ledger: 12345,
      network: "stellar:testnet",
      status: "confirmed"
    });

    await expect(
      settlement.getSettlementByTransactionHash("tx_exact_123", "stellar:testnet")
    ).resolves.toMatchObject({
      paymentAttemptId: verified.paymentAttemptId,
      status: "confirmed"
    });
  });

  it("converges concurrent and repeated settlement requests on one result", async () => {
    const attemptStore = new InMemoryPaymentAttemptStore();
    const settlementStore = new InMemorySettlementStore();
    const receiptService = new ReceiptService();
    const settleExact = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        transactionHash: "tx_concurrent_123",
        ledger: 12346,
        status: "confirmed" as const,
        adapter: "@x402/stellar" as const
      };
    });
    const concurrentAdapter: X402StellarAdapter = {
      verifyExact: adapter.verifyExact,
      quoteSettlementFee: stubQuoteSettlementFee,
      settleExact
    };
    const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });
    const verification = new PaymentVerificationService(config, {
      adapter: concurrentAdapter,
      attemptStore
    });
    const services = [
      new SettlementService(config, {
        adapter: concurrentAdapter,
        attemptStore,
        settlementStore,
        receiptService
      }),
      new SettlementService(config, {
        adapter: concurrentAdapter,
        attemptStore,
        settlementStore,
        receiptService
      })
    ];
    await verification.verify(testPaymentRequest);

    const [first, concurrent] = await Promise.all(
      services.map(async (service) => service.settle(testPaymentRequest))
    );
    const retry = await services[0]!.settle(testPaymentRequest);

    expect(concurrent).toEqual(first);
    expect(retry).toEqual(first);
    expect(settleExact).toHaveBeenCalledTimes(1);
  });

  it("independently re-verifies immediately before official settlement", async () => {
    const attemptStore = new InMemoryPaymentAttemptStore();
    const verifyExact = vi.fn(adapter.verifyExact);
    const settlementAdapter: X402StellarAdapter = { ...adapter, verifyExact };
    const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });
    const verification = new PaymentVerificationService(config, {
      adapter: settlementAdapter,
      attemptStore
    });
    const settlement = new SettlementService(config, {
      adapter: settlementAdapter,
      attemptStore
    });
    await verification.verify(testPaymentRequest);

    await settlement.settle(testPaymentRequest);

    expect(verifyExact).toHaveBeenCalledTimes(2);
  });

  it("rejects a simulation result that changes after the earlier verification", async () => {
    const attemptStore = new InMemoryPaymentAttemptStore();
    const settleExact = vi.fn(adapter.settleExact);
    const changingAdapter: X402StellarAdapter = {
      verifyExact: vi
        .fn()
        .mockResolvedValueOnce({ valid: true, adapter: "@x402/stellar" })
        .mockResolvedValueOnce({
          valid: false,
          failureCode: "AMOUNT_MISMATCH",
          failureReason: "Fresh simulation amount changed.",
          officialContext: { invalidReason: "invalid_exact_stellar_payload_event_wrong_amount" },
          adapter: "@x402/stellar"
        }),
      settleExact
    };
    const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });
    const verification = new PaymentVerificationService(config, {
      adapter: changingAdapter,
      attemptStore
    });
    const settlement = new SettlementService(config, {
      adapter: changingAdapter,
      attemptStore
    });
    await verification.verify(testPaymentRequest);

    await expect(settlement.settle(testPaymentRequest)).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
      details: {
        stage: "simulation",
        invalidReason: "invalid_exact_stellar_payload_event_wrong_amount"
      }
    });
    expect(settleExact).not.toHaveBeenCalled();
  });

  it.each([
    ["timed_out", "tx_timeout"],
    ["failed", "tx_failed"]
  ] as const)("persists %s finality without issuing a success response", async (status, hash) => {
    const attemptStore = new InMemoryPaymentAttemptStore();
    const settlementStore = new InMemorySettlementStore();
    const settleExact = vi.fn(async () => ({
      status,
      transactionHash: hash,
      failureCode: "SETTLEMENT_FAILED" as const,
      failureReason: `Settlement ${status}.`,
      officialContext: { stage: status === "timed_out" ? "timeout" : "failed" },
      adapter: "@x402/stellar" as const
    }));
    const failingAdapter: X402StellarAdapter = {
      async verifyExact() {
        return { valid: true, adapter: "@x402/stellar" };
      },
      quoteSettlementFee: stubQuoteSettlementFee,
      settleExact
    };
    const enqueue = vi.fn(async () => undefined);
    const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });
    const verification = new PaymentVerificationService(config, {
      adapter: failingAdapter,
      attemptStore
    });
    const settlement = new SettlementService(config, {
      adapter: failingAdapter,
      attemptStore,
      settlementStore,
      reconciliationScheduler: { enqueue }
    });
    const verified = await verification.verify(testPaymentRequest);

    await expect(settlement.settle(testPaymentRequest)).rejects.toMatchObject({
      code: "SETTLEMENT_FAILED",
      details: { status, transactionHash: hash }
    });
    await expect(
      settlement.getSettlementByTransactionHash(hash, "stellar:testnet")
    ).resolves.toMatchObject({
      paymentAttemptId: verified.paymentAttemptId,
      status
    });
    await expect(attemptStore.getPaymentAttempt(verified.paymentAttemptId)).resolves.toMatchObject({
      status
    });
    await expect(settlement.settle(testPaymentRequest)).rejects.toMatchObject({
      code: "SETTLEMENT_FAILED",
      details: { status, transactionHash: hash }
    });
    expect(settleExact).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects settlement when the payload differs from the verified attempt", async () => {
    const attemptStore = new InMemoryPaymentAttemptStore();
    const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });
    const verification = new PaymentVerificationService(config, { adapter, attemptStore });
    const settlement = new SettlementService(config, { adapter, attemptStore });
    await verification.verify(testPaymentRequest);

    await expect(
      settlement.settle({
        ...testPaymentRequest,
        paymentPayload: {
          ...testPaymentPayload,
          payload: {
            transaction: Buffer.from("different-transaction-xdr").toString("base64")
          }
        }
      })
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_PAYLOAD"
    });
  });
});

describe("SettlementService fee ceiling enforcement", () => {
  async function verifiedAttempt(
    feeStroops: number,
    overrides: {
      configEnv?: Record<string, string>;
      auditLogService?: PaymentAuditLogger;
    } = {}
  ) {
    const attemptStore = new InMemoryPaymentAttemptStore();
    const settlementStore = new InMemorySettlementStore();
    const config = loadConfig({
      STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId,
      ...(overrides.configEnv ?? {})
    });
    const quoteSettlementFee = async () => ({
      feeStroops,
      resourceFeeStroops: feeStroops - 100,
      inclusionFeeStroops: 100
    });
    const settleExact = vi.fn(async () => ({
      transactionHash: "tx_fee_ceiling",
      ledger: 12345,
      status: "confirmed" as const,
      adapter: "@x402/stellar" as const
    }));
    const feeAdapter: X402StellarAdapter = {
      async verifyExact() {
        return { valid: true, adapter: "@x402/stellar" };
      },
      quoteSettlementFee,
      settleExact
    };
    const verification = new PaymentVerificationService(config, {
      adapter: feeAdapter,
      attemptStore
    });
    const settlement = new SettlementService(config, {
      adapter: feeAdapter,
      attemptStore,
      settlementStore,
      ...(overrides.auditLogService === undefined
        ? {}
        : { auditLogService: overrides.auditLogService })
    });
    const verified = await verification.verify(testPaymentRequest);
    return { attemptStore, settlementStore, config, settlement, settleExact, verified };
  }

  it("blocks settlement above the ceiling before signing and leaves the payment reconcilable", async () => {
    const { attemptStore, settlementStore, settlement, settleExact, verified } =
      await verifiedAttempt(60_000);

    await expect(settlement.settle(testPaymentRequest)).rejects.toMatchObject({
      code: "FEE_CEILING_EXCEEDED",
      details: {
        stage: "fee_ceiling",
        feeStroops: 60_000,
        ceilingStroops: 50_000
      }
    });
    expect(settleExact).not.toHaveBeenCalled();

    await expect(attemptStore.getPaymentAttempt(verified.paymentAttemptId)).resolves.toMatchObject({
      status: "failed",
      failureCode: "FEE_CEILING_EXCEEDED",
      failureReason: expect.stringContaining("60000")
    });
    await expect(
      settlementStore.getSettlementByAttempt(verified.paymentAttemptId)
    ).resolves.toMatchObject({
      status: "failed",
      transactionHash: null,
      reconciliationState: "not_required"
    });

    // A retry returns the stored failure and never signs.
    await expect(settlement.settle(testPaymentRequest)).rejects.toMatchObject({
      code: "FEE_CEILING_EXCEEDED"
    });
    expect(settleExact).not.toHaveBeenCalled();
  });

  it("allows settlement at the ceiling and records the fee values in the audit log", async () => {
    const records: Array<Record<string, unknown>> = [];
    const auditLogService = {
      async record(input: { action: string; metadata?: Record<string, unknown> }) {
        records.push(input as Record<string, unknown>);
      }
    };
    const { settlement, settleExact } = await verifiedAttempt(50_000, { auditLogService });

    await expect(settlement.settle(testPaymentRequest)).resolves.toMatchObject({
      transactionHash: "tx_fee_ceiling",
      status: "confirmed"
    });
    expect(settleExact).toHaveBeenCalledTimes(1);

    const settleRecord = records.find((record) => record.action === "payment.settle") as
      | { metadata: Record<string, unknown> }
      | undefined;
    expect(settleRecord?.metadata).toMatchObject({
      feeStroops: 50_000,
      feeCeilingStroops: 50_000,
      feeCeilingOverridden: false
    });
    expect(JSON.stringify(records)).not.toMatch(/secret|seed|private|signature/i);
  });

  it("records the fee values and no signer material when the ceiling is exceeded", async () => {
    const records: Array<Record<string, unknown>> = [];
    const auditLogService = {
      async record(input: { action: string; metadata?: Record<string, unknown> }) {
        records.push(input as Record<string, unknown>);
      }
    };
    const { settlement } = await verifiedAttempt(60_000, { auditLogService });

    await expect(settlement.settle(testPaymentRequest)).rejects.toMatchObject({
      code: "FEE_CEILING_EXCEEDED"
    });

    const exceeded = records.find(
      (record) => record.action === "payment.settle.fee_ceiling_exceeded"
    ) as { metadata: Record<string, unknown> } | undefined;
    expect(exceeded?.metadata).toMatchObject({
      feeStroops: 60_000,
      ceilingStroops: 50_000,
      network: "stellar:testnet"
    });
    expect(JSON.stringify(records)).not.toMatch(/secret|seed|private|signature/i);
  });

  it("allows an explicit operator override when overrides are enabled", async () => {
    const records: Array<Record<string, unknown>> = [];
    const auditLogService = {
      async record(input: { action: string; metadata?: Record<string, unknown> }) {
        records.push(input as Record<string, unknown>);
      }
    };
    const { settlement, settleExact } = await verifiedAttempt(60_000, {
      configEnv: {
        STELLAR_FEE_CEILING_STROOPS: "50000",
        STELLAR_MAX_TRANSACTION_FEE_STROOPS: "100000",
        STELLAR_FEE_CEILING_OVERRIDE_ENABLED: "true"
      },
      auditLogService
    });

    await expect(
      settlement.settle(testPaymentRequest, {
        feeCeilingOverride: { ceilingStroops: 75_000, operatorId: "op-1", reason: "fees spiked" }
      })
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(settleExact).toHaveBeenCalledTimes(1);

    const settleRecord = records.find((record) => record.action === "payment.settle") as
      | { metadata: Record<string, unknown> }
      | undefined;
    expect(settleRecord?.metadata).toMatchObject({
      feeStroops: 60_000,
      feeCeilingStroops: 75_000,
      feeCeilingOverridden: true,
      feeCeilingOverrideOperatorId: "op-1",
      feeCeilingOverrideReason: "fees spiked"
    });
  });

  it("denies an operator override when overrides are disabled", async () => {
    const { settlement, settleExact } = await verifiedAttempt(60_000);

    await expect(
      settlement.settle(testPaymentRequest, {
        feeCeilingOverride: { ceilingStroops: 75_000, operatorId: "op-1", reason: "fees spiked" }
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(settleExact).not.toHaveBeenCalled();
  });

  it("rejects a malformed override before signing", async () => {
    const { settlement, settleExact } = await verifiedAttempt(60_000, {
      configEnv: { STELLAR_FEE_CEILING_OVERRIDE_ENABLED: "true" }
    });

    await expect(
      settlement.settle(testPaymentRequest, {
        feeCeilingOverride: { ceilingStroops: 50_000, operatorId: "op-1", reason: "no raise" }
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(settleExact).not.toHaveBeenCalled();
  });

  it("fails closed when the adapter cannot quote a fee", async () => {
    const attemptStore = new InMemoryPaymentAttemptStore();
    const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });
    const quoteLessAdapter: X402StellarAdapter = {
      async verifyExact() {
        return { valid: true, adapter: "@x402/stellar" };
      },
      settleExact: vi.fn(async () => ({
        transactionHash: "tx_should_not_happen",
        ledger: 1,
        status: "confirmed" as const,
        adapter: "@x402/stellar" as const
      }))
    };
    const verification = new PaymentVerificationService(config, {
      adapter: quoteLessAdapter,
      attemptStore
    });
    const settlement = new SettlementService(config, { adapter: quoteLessAdapter, attemptStore });
    await verification.verify(testPaymentRequest);

    await expect(settlement.settle(testPaymentRequest)).rejects.toMatchObject({
      code: "SETTLEMENT_FAILED",
      details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" }
    });
    expect(quoteLessAdapter.settleExact).not.toHaveBeenCalled();
  });

  it("fails closed when the fee quote fails", async () => {
    const attemptStore = new InMemoryPaymentAttemptStore();
    const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });
    const settleExact = vi.fn(async () => ({
      transactionHash: "tx_should_not_happen",
      ledger: 1,
      status: "confirmed" as const,
      adapter: "@x402/stellar" as const
    }));
    const failingQuoteAdapter: X402StellarAdapter = {
      async verifyExact() {
        return { valid: true, adapter: "@x402/stellar" };
      },
      async quoteSettlementFee() {
        throw new Error("rpc down");
      },
      settleExact
    };
    const verification = new PaymentVerificationService(config, {
      adapter: failingQuoteAdapter,
      attemptStore
    });
    const settlement = new SettlementService(config, {
      adapter: failingQuoteAdapter,
      attemptStore
    });
    await verification.verify(testPaymentRequest);

    await expect(settlement.settle(testPaymentRequest)).rejects.toMatchObject({
      code: "SETTLEMENT_FAILED",
      details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" }
    });
    expect(settleExact).not.toHaveBeenCalled();
  });
});
