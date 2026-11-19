import { z } from "zod";
import { type SettleResponse } from "@x402/core/types";

import { LumenError, isErrorCode, type AppConfig, type PaymentAttempt } from "@lumenbazaar/shared";

import { computePaymentHash } from "./hash.js";
import {
  type NormalizedVerifyPaymentRequest,
  parseVerifyPaymentRequest
} from "./paymentPayload.js";
import { InMemoryPaymentAttemptStore, type PaymentAttemptStore } from "./paymentAttemptStore.js";
import { type PaymentStatePersistence } from "./paymentStatePersistence.js";
import { type PaymentReconciliationScheduler } from "./reconciliation.js";
import { ReceiptService } from "./receipt.js";
import { InMemorySettlementStore, type SettlementStore } from "./settlementStore.js";
import {
  checkSettlementFeeCeiling,
  feeCeilingExceededMessage,
  resolveEffectiveFeeCeiling,
  type EffectiveFeeCeiling,
  type FeeCeilingDecision,
  type FeeCeilingOverride,
  type SettlementFeeQuote
} from "./settlementFeeCeiling.js";
import { type PaymentAuditLogger } from "./verification.js";
import {
  type X402SettlementResult,
  type X402StellarAdapter,
  createX402StellarAdapter
} from "./x402Adapter.js";

export const settlePaymentRequestSchema = z.object({
  x402Version: z.literal(2),
  paymentPayload: z.unknown(),
  paymentRequirements: z.unknown()
});

export type SettlementServiceOptions = {
  auditLogService?: PaymentAuditLogger;
  adapter?: X402StellarAdapter;
  attemptStore?: PaymentAttemptStore;
  settlementStore?: SettlementStore;
  receiptService?: ReceiptService;
  statePersistence?: PaymentStatePersistence;
  reconciliationScheduler?: PaymentReconciliationScheduler;
};

export type SettlementSettleOptions = {
  /**
   * Explicit operator override for the fee ceiling, for this settlement
   * only. Denied unless the deployment enables overrides
   * (`STELLAR_FEE_CEILING_OVERRIDE_ENABLED`) and the override carries an
   * operator identity and a reason. See
   * docs/payments/settlement-fee-ceilings.md.
   */
  feeCeilingOverride?: FeeCeilingOverride;
};

export type SettlementServiceResult = {
  correlationId: string;
  settlementId: string;
  receiptId: string;
  transactionHash: string;
  ledger: number;
  network: NormalizedVerifyPaymentRequest["network"];
  status: "confirmed";
  amount: string;
};

export type LumenSettleResponse = SettleResponse & {
  success: true;
  extra: {
    lumenbazaar: Omit<SettlementServiceResult, "amount" | "network">;
  };
};

export function toLumenSettleResponse(result: SettlementServiceResult): LumenSettleResponse {
  const { amount, network, ...projectResult } = result;
  return {
    success: true,
    transaction: result.transactionHash,
    network,
    amount,
    extra: {
      lumenbazaar: projectResult
    }
  };
}

export class SettlementService {
  private readonly auditLogService: PaymentAuditLogger | undefined;
  private readonly adapter: X402StellarAdapter;
  private readonly attemptStore: PaymentAttemptStore;
  private readonly settlementStore: SettlementStore;
  private readonly receiptService: ReceiptService;
  private readonly statePersistence: PaymentStatePersistence | undefined;
  private readonly reconciliationScheduler: PaymentReconciliationScheduler | undefined;

  constructor(
    private readonly config: AppConfig,
    options: SettlementServiceOptions = {}
  ) {
    this.adapter = options.adapter ?? createX402StellarAdapter();
    this.auditLogService = options.auditLogService;
    this.attemptStore = options.attemptStore ?? new InMemoryPaymentAttemptStore();
    this.settlementStore = options.settlementStore ?? new InMemorySettlementStore();
    this.receiptService = options.receiptService ?? new ReceiptService();
    this.statePersistence = options.statePersistence;
    this.reconciliationScheduler = options.reconciliationScheduler;
  }

  async settle(
    input: unknown,
    options: SettlementSettleOptions = {}
  ): Promise<SettlementServiceResult> {
    const parsedResult = settlePaymentRequestSchema.safeParse(input);
    if (!parsedResult.success) {
      throw new LumenError("INVALID_PAYMENT_PAYLOAD", "Settlement request is not valid x402 v2.", {
        details: {
          requiredVersion: 2,
          issues: parsedResult.error.issues
        }
      });
    }
    const parsed = parsedResult.data;
    const normalized = parseVerifyPaymentRequest(
      {
        x402Version: parsed.x402Version,
        paymentPayload: parsed.paymentPayload,
        paymentRequirements: parsed.paymentRequirements
      },
      this.config
    );
    const paymentHash = computePaymentHash(normalized.paymentPayload);
    const attempt = await this.attemptStore.findPaymentAttemptByHash(paymentHash);

    if (attempt === undefined) {
      throw new LumenError("INVALID_PAYMENT_PAYLOAD", "Payment attempt was not found.");
    }

    if (attempt.paymentHash !== paymentHash) {
      throw new LumenError("INVALID_PAYMENT_PAYLOAD", "Payment payload does not match attempt.");
    }

    const existingResult = await this.existingResult(attempt);
    if (existingResult !== undefined) {
      return existingResult;
    }
    const claimedAttempt = await this.attemptStore.claimSettlement(attempt.id);
    if (claimedAttempt === undefined) {
      return this.waitForDurableResult(attempt.id);
    }

    const verification = await this.adapter.verifyExact({
      paymentPayload: normalized.paymentPayload,
      paymentRequirements: normalized.paymentRequirements,
      normalizedRequest: normalized
    });
    if (!verification.valid) {
      await this.attemptStore.updatePaymentAttempt(attempt.id, {
        status: "failed",
        failureCode: verification.failureCode ?? "INVALID_SIGNATURE",
        failureReason:
          verification.failureReason ?? "Fresh Stellar verification rejected the settlement."
      });
      throw new LumenError(
        verification.failureCode ?? "INVALID_SIGNATURE",
        verification.failureReason ?? "Fresh Stellar verification rejected the settlement.",
        {
          details: {
            stage: "simulation",
            ...(verification.officialContext ?? {})
          }
        }
      );
    }

    // Fee ceiling gate: re-quote the fee from a fresh simulation and compare
    // it against the configured ceiling immediately before signing. This
    // runs after the fresh re-verification above and before settleExact,
    // which is where the facilitator signs. On excess (or when the fee
    // cannot be established) the payment is recorded as failed and signing
    // never happens.
    const feeDecision = await this.enforceFeeCeilingBeforeSigning(attempt, normalized, options);
    const adapterResult = await this.settleWithAdapter(normalized);
    if (
      adapterResult.status !== "confirmed" ||
      adapterResult.transactionHash === undefined ||
      adapterResult.ledger === undefined
    ) {
      return this.recordFailedSettlement(attempt, normalized, adapterResult);
    }

    const settledAt = new Date().toISOString();
    const settlementInput = {
      correlationId: attempt.correlationId,
      paymentAttemptId: attempt.id,
      transactionHash: adapterResult.transactionHash,
      ledger: adapterResult.ledger,
      network: normalized.network,
      amount: normalized.amount,
      assetCode: normalized.asset.code,
      assetIssuer: normalized.asset.issuer,
      status: "confirmed",
      reconciliationState: "not_required",
      settledAt
    } as const;
    const persisted =
      this.statePersistence === undefined
        ? undefined
        : await this.statePersistence.recordConfirmed({ attempt, settlement: settlementInput });
    const settlement =
      persisted?.settlement ?? (await this.settlementStore.createSettlement(settlementInput));
    const confirmedAttempt =
      persisted?.attempt ??
      (await this.attemptStore.updatePaymentAttempt(attempt.id, { status: "confirmed" }));
    const receipt =
      persisted?.receipt ??
      (await this.receiptService.finalizeSettlementReceipt(confirmedAttempt, settlement));

    await this.auditLogService?.record({
      action: "payment.settle",
      actorId: attempt.sellerId,
      actorType: "facilitator",
      targetId: settlement.id,
      targetType: "settlement",
      metadata: {
        amount: settlement.amount,
        assetCode: settlement.assetCode,
        feeCeilingOverridden: feeDecision.overridden,
        feeCeilingStroops: feeDecision.ceilingStroops,
        feeStroops: feeDecision.feeStroops,
        ledger: settlement.ledger,
        network: settlement.network,
        paymentAttemptId: attempt.id,
        receiptId: receipt.id,
        resourceId: attempt.resourceId,
        status: settlement.status,
        transactionHash: settlement.transactionHash,
        ...(feeDecision.overridden && feeDecision.override !== undefined
          ? {
              feeCeilingOverrideOperatorId: feeDecision.override.operatorId,
              feeCeilingOverrideReason: feeDecision.override.reason
            }
          : {})
      }
    });

    return {
      correlationId: attempt.correlationId,
      settlementId: settlement.id,
      receiptId: receipt.id,
      transactionHash: adapterResult.transactionHash,
      ledger: adapterResult.ledger,
      network: normalized.network,
      status: "confirmed",
      amount: normalized.amount
    };
  }

  async getSettlementByTransactionHash(transactionHash: string, network: string) {
    return this.settlementStore.getSettlementByTransactionHash(transactionHash, network);
  }

  getReceiptService() {
    return this.receiptService;
  }

  private async existingResult(
    attempt: PaymentAttempt
  ): Promise<SettlementServiceResult | undefined> {
    const settlement = await this.settlementStore.getSettlementByAttempt(attempt.id);
    if (settlement?.status === "confirmed") {
      const receipt = await this.receiptService.getReceiptByAttempt(attempt.id);
      if (
        receipt !== undefined &&
        settlement.transactionHash !== null &&
        settlement.ledger !== null
      ) {
        return {
          correlationId: attempt.correlationId,
          settlementId: settlement.id,
          receiptId: receipt.id,
          transactionHash: settlement.transactionHash,
          ledger: settlement.ledger,
          network: attempt.network,
          status: "confirmed",
          amount: attempt.amount
        };
      }
    }
    if (settlement?.status === "failed" || settlement?.status === "timed_out") {
      throw new LumenError(
        settlementFailureCode(attempt.failureCode),
        attempt.failureReason ?? "Stellar settlement failed.",
        {
          details: {
            status: settlement.status,
            ...(settlement.transactionHash === null
              ? {}
              : { transactionHash: settlement.transactionHash })
          }
        }
      );
    }
    return undefined;
  }

  private async waitForDurableResult(paymentAttemptId: string): Promise<SettlementServiceResult> {
    for (let check = 0; check < 250; check += 1) {
      const current = await this.attemptStore.getPaymentAttempt(paymentAttemptId);
      if (current === undefined) {
        break;
      }
      const result = await this.existingResult(current);
      if (result !== undefined) {
        return result;
      }
      if (current.status === "failed" || current.status === "timed_out") {
        throw new LumenError(
          settlementFailureCode(current.failureCode),
          current.failureReason ?? "Stellar settlement failed."
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new LumenError("SETTLEMENT_FAILED", "Settlement is already in progress.", {
      statusCode: 409,
      details: { status: "settling" }
    });
  }

  private async enforceFeeCeilingBeforeSigning(
    attempt: PaymentAttempt,
    normalized: NormalizedVerifyPaymentRequest,
    options: SettlementSettleOptions
  ): Promise<FeeCeilingDecision> {
    let ceiling: EffectiveFeeCeiling;
    try {
      ceiling = resolveEffectiveFeeCeiling(this.config, options.feeCeilingOverride);
    } catch (error) {
      return this.recordFeeGateFailure(attempt, normalized, error);
    }

    let quote: SettlementFeeQuote;
    try {
      const quoteSettlementFee = this.adapter.quoteSettlementFee;
      if (quoteSettlementFee === undefined) {
        throw new LumenError(
          "SETTLEMENT_FAILED",
          "Settlement adapter cannot quote the settlement fee before signing.",
          { details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" } }
        );
      }
      quote = await quoteSettlementFee({
        paymentPayload: normalized.paymentPayload,
        paymentRequirements: normalized.paymentRequirements,
        normalizedRequest: normalized
      });
    } catch (error) {
      return this.recordFeeGateFailure(attempt, normalized, error);
    }

    const decision = checkSettlementFeeCeiling({ quote, ceiling });
    if (!decision.allowed) {
      await this.auditFeeCeilingExceeded(attempt, normalized, decision);
      return this.recordFailedSettlement(attempt, normalized, {
        adapter: "@x402/stellar",
        status: "failed",
        failureCode: "FEE_CEILING_EXCEEDED",
        failureReason: feeCeilingExceededMessage(decision.feeStroops, decision.ceilingStroops),
        officialContext: {
          stage: "fee_ceiling",
          ceilingStroops: decision.ceilingStroops,
          feeStroops: decision.feeStroops,
          feeCeilingOverridden: decision.overridden,
          ...(decision.overridden && decision.override !== undefined
            ? { feeCeilingOverrideOperatorId: decision.override.operatorId }
            : {})
        }
      });
    }
    return decision;
  }

  /**
   * Record a pre-signing fee gate failure as a terminal, reconcilable
   * failure: the attempt leaves "settling" for "failed" with the cause in
   * its failure code and reason, and a failed settlement record is created
   * with no transaction hash (nothing was signed or submitted, so there is
   * nothing on-chain to reconcile). Used for rejected overrides and for
   * fees that cannot be quoted; the fee-ceiling-exceeded case has its own
   * recorder above so its audit event can carry the fee values.
   */
  private async recordFeeGateFailure(
    attempt: PaymentAttempt,
    normalized: NormalizedVerifyPaymentRequest,
    error: unknown
  ): Promise<never> {
    const failure =
      error instanceof LumenError
        ? error
        : new LumenError(
            "SETTLEMENT_FAILED",
            "Settlement fee could not be checked before signing.",
            { details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" } }
          );
    await this.auditLogService?.record({
      action: "payment.settle.fee_check_failed",
      actorId: attempt.sellerId,
      actorType: "facilitator",
      targetId: attempt.id,
      targetType: "payment_attempt",
      metadata: {
        amount: normalized.amount,
        assetCode: normalized.asset.code,
        failureCode: failure.code,
        network: normalized.network,
        paymentAttemptId: attempt.id,
        resourceId: attempt.resourceId
      }
    });
    return this.recordFailedSettlement(attempt, normalized, {
      adapter: "@x402/stellar",
      status: "failed",
      failureCode: failure.code,
      failureReason: failure.message,
      officialContext: { stage: "fee_ceiling", ...(failure.details ?? {}) }
    });
  }

  private async auditFeeCeilingExceeded(
    attempt: PaymentAttempt,
    normalized: NormalizedVerifyPaymentRequest,
    decision: Extract<FeeCeilingDecision, { allowed: false }>
  ): Promise<void> {
    await this.auditLogService?.record({
      action: "payment.settle.fee_ceiling_exceeded",
      actorId: attempt.sellerId,
      actorType: "facilitator",
      targetId: attempt.id,
      targetType: "payment_attempt",
      metadata: {
        amount: normalized.amount,
        assetCode: normalized.asset.code,
        ceilingStroops: decision.ceilingStroops,
        feeStroops: decision.feeStroops,
        network: normalized.network,
        paymentAttemptId: attempt.id,
        resourceId: attempt.resourceId,
        ...(decision.overridden && decision.override !== undefined
          ? {
              feeCeilingOverrideOperatorId: decision.override.operatorId,
              feeCeilingOverrideReason: decision.override.reason
            }
          : {})
      }
    });
  }

  private async settleWithAdapter(
    normalized: NormalizedVerifyPaymentRequest
  ): Promise<X402SettlementResult> {
    if (this.adapter.settleExact === undefined) {
      throw new LumenError(
        "SETTLEMENT_FAILED",
        "@x402/stellar settlement adapter is not available in this runtime."
      );
    }

    return this.adapter.settleExact({
      paymentPayload: normalized.paymentPayload,
      paymentRequirements: normalized.paymentRequirements,
      normalizedRequest: normalized
    });
  }

  private async recordFailedSettlement(
    attempt: PaymentAttempt,
    normalized: NormalizedVerifyPaymentRequest,
    result: X402SettlementResult
  ): Promise<never> {
    const status = result.status === "timed_out" ? "timed_out" : "failed";
    const failureCode = result.failureCode ?? "SETTLEMENT_FAILED";
    const failureReason = result.failureReason ?? "Stellar settlement failed.";
    const settlementInput = {
      correlationId: attempt.correlationId,
      paymentAttemptId: attempt.id,
      ...(result.transactionHash === undefined ? {} : { transactionHash: result.transactionHash }),
      network: normalized.network,
      amount: normalized.amount,
      assetCode: normalized.asset.code,
      assetIssuer: normalized.asset.issuer,
      status,
      reconciliationState: result.transactionHash === undefined ? "not_required" : "pending"
    } as const;
    const settlement =
      this.statePersistence === undefined
        ? await this.settlementStore.createSettlement(settlementInput)
        : (
            await this.statePersistence.recordFailed({
              attempt,
              settlement: settlementInput,
              failureCode,
              failureReason
            })
          ).settlement;
    // NOTE: Settlement reconciliation job enqueueing has been moved to the outbox relay.
    // When recordFailed is called above (if using statePersistence), an outbox event with
    // eventType "settlement.reconciliation_enqueued" is written in the same transaction
    // as the settlement record. The outbox relay worker will pick up this event and
    // enqueue the reconciliation job, ensuring atomicity and preventing job loss.
    if (this.statePersistence === undefined) {
      await this.attemptStore.updatePaymentAttempt(attempt.id, {
        status,
        failureCode,
        failureReason
      });
    }
    throw new LumenError(failureCode, failureReason, {
      details: {
        status,
        ...(result.transactionHash === undefined
          ? {}
          : { transactionHash: result.transactionHash }),
        ...(result.officialContext ?? {})
      }
    });
  }
}

function settlementFailureCode(code: string | null) {
  return code !== null && isErrorCode(code) ? code : "SETTLEMENT_FAILED";
}
