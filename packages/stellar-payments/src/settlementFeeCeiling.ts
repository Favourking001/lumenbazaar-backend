import { LumenError, type AppConfig } from "@lumenbazaar/shared";

import {
  type ExactStellarPaymentPayload,
  type ExactStellarPaymentRequirements,
  type NormalizedVerifyPaymentRequest
} from "./paymentPayload.js";

/**
 * Fee ceiling enforcement for Stellar settlement.
 *
 * The settlement transaction the facilitator signs pays
 * `minResourceFee + inclusionFeeStroops` (the same derivation the
 * `@x402/stellar` facilitator uses: the Soroban simulation's minimum
 * resource fee plus the configured inclusion fee bid). Fee conditions can
 * change between the initial verification and signing, so the fee is
 * re-quoted from a fresh simulation immediately before signing and compared
 * against the configured ceiling. The ceiling is enforced here, in this
 * repository, rather than relying only on the third-party facilitator's
 * internal check, so the decision — including the fee values and any
 * operator override — is visible in our own records and audit log.
 *
 * No signer material is involved anywhere in this module: only stroop
 * amounts, ceiling values, and operator-supplied override metadata.
 */

export type SettlementFeeQuote = {
  /** Total fee the settlement transaction would pay, in stroops. */
  feeStroops: number;
  /** Simulation-derived minimum resource fee, in stroops. */
  resourceFeeStroops: number;
  /** Configured inclusion fee bid, in stroops. */
  inclusionFeeStroops: number;
};

export type SettlementFeeQuoteInput = {
  paymentPayload: ExactStellarPaymentPayload;
  paymentRequirements: ExactStellarPaymentRequirements;
  normalizedRequest: NormalizedVerifyPaymentRequest;
};

export type SettlementFeeQuoter = {
  quoteSettlementFee(input: SettlementFeeQuoteInput): Promise<SettlementFeeQuote>;
};

/**
 * Explicit operator override for a single settlement.
 *
 * Overrides are denied by default: they are honoured only when the
 * deployment enables them (`STELLAR_FEE_CEILING_OVERRIDE_ENABLED=true`) and
 * the override is supplied with an operator identity and a reason. The
 * override is recorded in the audit log, so every above-ceiling settlement
 * is attributable to the operator who authorized it.
 */
export type FeeCeilingOverride = {
  /** Raised ceiling for this settlement only, in stroops. */
  ceilingStroops: number;
  /** Identity of the operator authorizing the override. */
  operatorId: string;
  /** Human-readable reason for the override; recorded in the audit log. */
  reason: string;
};

export type EffectiveFeeCeiling =
  | { ceilingStroops: number; overridden: false }
  | { ceilingStroops: number; overridden: true; override: FeeCeilingOverride };

export type FeeCeilingDecision =
  | {
      allowed: true;
      feeStroops: number;
      ceilingStroops: number;
      overridden: boolean;
      override?: FeeCeilingOverride;
    }
  | {
      allowed: false;
      feeStroops: number;
      ceilingStroops: number;
      overridden: boolean;
      override?: FeeCeilingOverride;
    };

/**
 * Resolve the ceiling that applies to one settlement.
 *
 * Without an override the configured ceiling applies. An override raises
 * the ceiling for this settlement only, and only when the deployment has
 * explicitly enabled overrides. Anything else fails closed: a disabled,
 * malformed, or ineffective override aborts the settlement before signing
 * instead of being silently downgraded to the configured ceiling.
 */
export function resolveEffectiveFeeCeiling(
  config: AppConfig,
  override?: FeeCeilingOverride
): EffectiveFeeCeiling {
  const configuredCeiling = config.settlement.feeCeilingStroops;
  if (override === undefined) {
    return { ceilingStroops: configuredCeiling, overridden: false };
  }

  if (!config.settlement.feeCeilingOverrideEnabled) {
    throw new LumenError("FORBIDDEN", "Fee ceiling overrides are disabled for this deployment.", {
      details: { stage: "fee_ceiling", overrideRequested: true }
    });
  }

  if (!Number.isSafeInteger(override.ceilingStroops) || override.ceilingStroops <= 0) {
    throw new LumenError("VALIDATION_FAILED", "Fee ceiling override must be a positive integer.", {
      details: { stage: "fee_ceiling" }
    });
  }

  if (override.operatorId.trim().length === 0 || override.reason.trim().length === 0) {
    throw new LumenError(
      "VALIDATION_FAILED",
      "Fee ceiling override requires an operatorId and a reason.",
      { details: { stage: "fee_ceiling" } }
    );
  }

  if (override.ceilingStroops <= configuredCeiling) {
    throw new LumenError(
      "VALIDATION_FAILED",
      "Fee ceiling override must raise the ceiling above the configured ceiling.",
      {
        details: {
          stage: "fee_ceiling",
          ceilingStroops: configuredCeiling,
          overrideCeilingStroops: override.ceilingStroops
        }
      }
    );
  }

  if (override.ceilingStroops > config.settlement.maxTransactionFeeStroops) {
    throw new LumenError(
      "VALIDATION_FAILED",
      "Fee ceiling override must not exceed the maximum transaction fee.",
      {
        details: {
          stage: "fee_ceiling",
          ceilingStroops: config.settlement.maxTransactionFeeStroops,
          overrideCeilingStroops: override.ceilingStroops
        }
      }
    );
  }

  return { ceilingStroops: override.ceilingStroops, overridden: true, override };
}

/** Compare a quoted fee against the effective ceiling. */
export function checkSettlementFeeCeiling(input: {
  quote: SettlementFeeQuote;
  ceiling: EffectiveFeeCeiling;
}): FeeCeilingDecision {
  const allowed = input.quote.feeStroops <= input.ceiling.ceilingStroops;
  return {
    allowed,
    feeStroops: input.quote.feeStroops,
    ceilingStroops: input.ceiling.ceilingStroops,
    overridden: input.ceiling.overridden,
    ...(input.ceiling.overridden ? { override: input.ceiling.override } : {})
  };
}

export function feeCeilingExceededMessage(feeStroops: number, ceilingStroops: number) {
  return (
    `Settlement fee ${feeStroops} stroops exceeds the fee ceiling of ` +
    `${ceilingStroops} stroops.`
  );
}

export type SorobanFeeQuoteTransport = (input: {
  rpcUrl: string;
  transactionXdr: string;
}) => Promise<{ minResourceFee: string }>;

/**
 * Quote the settlement fee with a fresh Soroban simulation.
 *
 * The payload transaction is simulated against the network's RPC endpoint
 * and the fee is derived exactly as the `@x402/stellar` facilitator derives
 * it: `minResourceFee + inclusionFeeStroops`. This is a read-only
 * simulation; nothing is signed or submitted.
 *
 * A failed simulation fails closed: the quoter throws and the caller must
 * abort settlement without signing.
 */
export function createSorobanSettlementFeeQuoter(
  config: AppConfig,
  transport: SorobanFeeQuoteTransport = simulateTransactionFee
): SettlementFeeQuoter {
  return {
    async quoteSettlementFee(input) {
      const network = config.networks[input.normalizedRequest.network];
      if (network === undefined) {
        throw new LumenError("UNSUPPORTED_NETWORK", "Payment network is not configured.", {
          details: { stage: "fee_ceiling", network: input.normalizedRequest.network }
        });
      }
      const inclusionFeeStroops = config.settlement.inclusionFeeStroops;
      let resourceFeeStroops: number;
      try {
        const result = await transport({
          rpcUrl: network.rpcUrl,
          transactionXdr: input.paymentPayload.payload.transaction
        });
        resourceFeeStroops = parseFeeStroops(result.minResourceFee);
      } catch (error) {
        if (error instanceof LumenError) {
          throw error;
        }
        throw new LumenError(
          "SETTLEMENT_FAILED",
          "Settlement fee could not be quoted before signing.",
          { details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" } }
        );
      }
      return {
        feeStroops: resourceFeeStroops + inclusionFeeStroops,
        resourceFeeStroops,
        inclusionFeeStroops
      };
    }
  };
}

async function simulateTransactionFee(input: {
  rpcUrl: string;
  transactionXdr: string;
}): Promise<{ minResourceFee: string }> {
  let response: Response;
  try {
    response = await fetch(input.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: { transaction: input.transactionXdr }
      }),
      signal: AbortSignal.timeout(5_000)
    });
  } catch {
    throw new LumenError(
      "SETTLEMENT_FAILED",
      "Settlement fee could not be quoted before signing.",
      {
        details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" }
      }
    );
  }

  if (!response.ok) {
    throw new LumenError(
      "SETTLEMENT_FAILED",
      "Settlement fee could not be quoted before signing.",
      {
        details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" }
      }
    );
  }

  const payload = (await response.json()) as {
    result?: { minResourceFee?: unknown; error?: unknown };
    error?: unknown;
  };
  if (
    payload.error !== undefined ||
    payload.result === undefined ||
    payload.result.error !== undefined ||
    typeof payload.result.minResourceFee !== "string"
  ) {
    throw new LumenError(
      "SETTLEMENT_FAILED",
      "Settlement fee could not be quoted before signing.",
      {
        details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" }
      }
    );
  }

  return { minResourceFee: payload.result.minResourceFee };
}

function parseFeeStroops(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new LumenError(
      "SETTLEMENT_FAILED",
      "Settlement fee could not be quoted before signing.",
      {
        details: { stage: "fee_ceiling", feeCheck: "quote_unavailable" }
      }
    );
  }
  return parsed;
}
