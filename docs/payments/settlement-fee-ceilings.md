# Stellar settlement fee ceilings

Settlement signs and submits a Stellar transaction on the facilitator's
behalf, and the fee that transaction pays depends on network conditions at
signing time. The fee is re-checked immediately before signing so a payment
is never submitted with an unexpectedly high network fee.

## How the fee is derived

The settlement transaction pays `minResourceFee + inclusionFeeStroops`:

- `minResourceFee` comes from a fresh Soroban `simulateTransaction` of the
  payment's transaction, run immediately before signing. It is the resource
  fee the network will charge for this exact transaction.
- `inclusionFeeStroops` is the configured inclusion fee bid
  (`STELLAR_INCLUSION_FEE_STROOPS`, default 100 stroops).

This is the same derivation the `@x402/stellar` facilitator uses
internally. The check is enforced here, in this repository, rather than
relying only on the facilitator library, so the decision — fee values and
any operator override — is visible in our own records and audit log.

## Configured ceilings

| Setting                           | Environment variable                   | Default                                        |
| --------------------------------- | -------------------------------------- | ---------------------------------------------- |
| Fee ceiling (stroops)             | `STELLAR_FEE_CEILING_STROOPS`          | `STELLAR_MAX_TRANSACTION_FEE_STROOPS` (50,000) |
| Maximum transaction fee (stroops) | `STELLAR_MAX_TRANSACTION_FEE_STROOPS`  | 50,000                                         |
| Inclusion fee bid (stroops)       | `STELLAR_INCLUSION_FEE_STROOPS`        | 100                                            |
| Fee ceiling overrides enabled     | `STELLAR_FEE_CEILING_OVERRIDE_ENABLED` | `false`                                        |

Startup validation fails closed:

- The ceiling must not be below the inclusion fee bid, or every settlement
  would be rejected.
- The ceiling must not exceed the maximum transaction fee. The maximum is
  the outer bound the settlement adapter enforces; a ceiling above it could
  never take effect. Raise both together to allow a higher fee.

## The pre-signing gate

`SettlementService.settle` runs the gate after the fresh re-verification
and before the adapter's `settleExact` (where signing happens):

1. Resolve the effective ceiling (configured ceiling, or an operator
   override — see below).
2. Quote the fee with a fresh simulation. The quote is read-only; nothing
   is signed or submitted to obtain it.
3. If the quoted fee is within the ceiling, signing proceeds. The fee, the
   ceiling, and whether an override applied are recorded in the
   `payment.settle` audit log entry.
4. If the quoted fee exceeds the ceiling, signing never happens. The
   payment attempt is recorded as `failed` with code
   `FEE_CEILING_EXCEEDED`, a failed settlement record is created with the
   fee and ceiling values in its failure reason, and an audit event
   `payment.settle.fee_ceiling_exceeded` is recorded. The error returned to
   the caller carries the fee and ceiling in its details.

The adapter must be able to quote the fee (`quoteSettlementFee`). If it
cannot — or the simulation fails — settlement aborts before signing with
`SETTLEMENT_FAILED` and the attempt is recorded as failed with the reason
`fee_check: quote_unavailable`. A fee that cannot be established is never
signed blind.

## Operator override policy

Overrides are denied by default. Two things must both be true for an
override to apply:

1. The deployment enables them: `STELLAR_FEE_CEILING_OVERRIDE_ENABLED=true`.
2. The settlement call supplies an explicit override with all three
   fields: `ceilingStroops` (the raised ceiling for this settlement only),
   `operatorId` (who authorized it), and `reason` (why).

An override is validated before it is used:

- It must raise the ceiling above the configured ceiling. An override that
  does not raise the ceiling is rejected.
- It must not exceed the maximum transaction fee, above which the adapter
  would reject the settlement anyway.
- It must carry a non-empty operator identity and reason.

A disabled, malformed, or ineffective override aborts the settlement
before signing with `FORBIDDEN` or `VALIDATION_FAILED`. It is never
silently downgraded to the configured ceiling: an operator who explicitly
asked for above-ceiling treatment must not have the payment proceed under
different terms than they authorized. The rejected override is recorded on
the failed attempt and in the audit log
(`payment.settle.fee_check_failed`).

When an override applies and the settlement succeeds, the override's
operator and reason are recorded in the `payment.settle` audit log entry.
When an override applies but the fee still exceeds the raised ceiling, the
settlement is blocked with `FEE_CEILING_EXCEEDED` and the attempted
override is recorded in the audit event, so the decision stays attributable.

## What happens to a blocked payment

A fee-ceiling block leaves the payment reconcilable:

- No transaction was signed or submitted, so there is no on-chain
  transaction to reconcile. The settlement record is created with status
  `failed` and `reconciliationState: "not_required"`.
- The payment attempt is `failed` with code `FEE_CEILING_EXCEEDED` and a
  failure reason carrying the quoted fee and the ceiling.
- The audit event carries the fee, the ceiling, the network, and any
  override that was applied or attempted.
- A retry of the same payment returns the stored failure; it never
  re-signs. The payment can proceed later with a fresh authorization once
  fees have fallen, or with an explicit operator override.

No signer material is ever logged: audit entries and error details carry
only stroop amounts, ceiling values, network and payment identifiers, and
operator-supplied override metadata.
