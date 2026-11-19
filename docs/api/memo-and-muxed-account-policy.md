# Memo and Muxed-Account Validation Policy

Single source of truth in code: `packages/shared/src/memoPolicy.ts`
(`assertPaymentMemoPolicy`, `validateStellarMemo`,
`validateMemoAndDestinationCombination`). The policy is enforced at the one
shared payment boundary, `parseVerifyPaymentRequest`
(`packages/stellar-payments/src/paymentPayload.ts`), which both
`POST /v1/verify` and `POST /v1/settle` pass through. Verification and
settlement therefore apply exactly the same policy, and unsupported forms
are rejected before the adapter verifies or signs anything.

## Why

A Stellar transaction memo and a muxed-account (`M...`) destination both
carry settlement attribution. An unsupported memo, or a memo combined with
a muxed destination, can make it ambiguous which account a payment should
be attributed to. The upstream x402 verifier does not inspect memos, so
this policy closes that gap at the facilitator boundary.

## Accepted memo types

| Memo type | Constraint                                | Notes                   |
| --------- | ----------------------------------------- | ----------------------- |
| `none`    | No value                                  | Always accepted.        |
| `text`    | At most 28 UTF-8 bytes, valid UTF-8       | Stellar protocol limit. |
| `id`      | Decimal uint64 string (`0` to `2^64 - 1`) |                         |
| `hash`    | Exactly 32 bytes                          |                         |
| `return`  | Exactly 32 bytes                          |                         |

Violations (oversized text, non-numeric or out-of-range id, short/long
hash or return, unknown memo type) are rejected with
`UNSUPPORTED_MEMO_OR_MUXED_ACCOUNT` (HTTP 400).

## Accepted destination forms

| Destination form       | Memo none | Memo text | Memo id  | Memo hash | Memo return |
| ---------------------- | --------- | --------- | -------- | --------- | ----------- |
| `G...` ed25519 account | accepted  | accepted  | accepted | accepted  | accepted    |
| `M...` muxed account   | rejected  | rejected  | rejected | rejected  | rejected    |
| `C...` contract        | rejected  | rejected  | rejected | rejected  | rejected    |
| Unrecognized form      | rejected  | rejected  | rejected | rejected  | rejected    |

Muxed-account destinations are rejected with every memo type, including
memo `none`. The x402 exact scheme requires the SEP-41 `transfer`
recipient to equal the `G...` address in `paymentRequirements.payTo`, so a
muxed destination can never settle to the required recipient; the muxed id
would also compete with the transaction memo for settlement attribution.
Contract destinations are rejected for the same reason: the required
recipient is a Stellar account, not a contract.

Destinations are read from SEP-41 `transfer` invocations (the `to`
argument) and from classic payment operations (`payment`,
`pathPaymentStrictSend`, `pathPaymentStrictReceive`, `createAccount`,
`accountMerge`). A transaction with no payment destination is still
memo-checked; its recipient is checked by the upstream verifier.

## What is not covered

- Payloads that do not decode as a Stellar transaction envelope are not
  inspected by this policy; the official x402 verifier rejects malformed
  transaction XDR before any signing takes place.
- Stellar XDR itself caps memo text at 28 bytes, so an oversized text memo
  cannot be expressed in a decodable envelope and is rejected as malformed
  by that verifier. The pure memo validator still enforces the limit for
  any memo value presented to it.
- The transaction source (payer) account is not restricted by this policy;
  attribution ambiguity concerns the recipient and the memo.
- Fee-bump envelopes are unwrapped and the inner transaction is inspected.

## Error

Unsupported memo or destination forms fail with:

```json
{
  "ok": false,
  "error": {
    "code": "UNSUPPORTED_MEMO_OR_MUXED_ACCOUNT",
    "message": "...",
    "details": {
      "policy": "memo-and-muxed-account",
      "memoType": "text",
      "destinationForm": "muxed",
      "destination": "M..."
    }
  }
}
```

HTTP status: `400`. The error is not retryable without changing the
transaction: the wallet must sign a new transaction with a supported memo
and a `G...` destination matching `payTo`.

## Test vectors

`packages/shared/src/memoPolicy.test.ts` covers every memo type (valid and
invalid values) and every destination form, including muxed accounts with
each memo type. `packages/stellar-payments/src/paymentPayload.test.ts`
covers enforcement at the verify/settle boundary: unsupported forms are
rejected before the adapter is called, and valid memos with a `G...`
destination pass through. All vectors use synthetic testnet data only.
