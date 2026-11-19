import {
  StrKey,
  TransactionBuilder,
  scValToNative,
  type FeeBumpTransaction,
  type Transaction,
  type xdr
} from "@stellar/stellar-sdk";

import { LumenError } from "./errors.js";
import { stellarPassphrases, type NetworkId } from "./networks.js";

/**
 * Memo and muxed-account validation policy for Stellar payments.
 *
 * This is the single shared definition of which memo types and address forms
 * the facilitator accepts at payment boundaries. Both the verification path
 * (`PaymentVerificationService`) and the settlement path
 * (`SettlementService`) enforce it through `parseVerifyPaymentRequest`, so
 * the policy cannot drift between the two paths.
 *
 * Accepted combinations:
 *
 * | Destination form          | Memo none | Memo text | Memo id | Memo hash | Memo return |
 * |---------------------------|-----------|-----------|---------|-----------|-------------|
 * | `G...` (ed25519 account)   | accepted  | accepted  | accepted| accepted  | accepted    |
 * | `M...` (muxed account)    | rejected  | rejected  | rejected| rejected  | rejected    |
 * | `C...` (contract)         | rejected  | rejected  | rejected| rejected  | rejected    |
 * | unrecognized form         | rejected  | rejected  | rejected| rejected  | rejected    |
 *
 * Muxed-account destinations are rejected outright. The x402 exact scheme
 * requires the SEP-41 transfer recipient to equal the `G...` address in
 * `paymentRequirements.payTo`, so a muxed destination can never settle to the
 * required recipient; the muxed id would also compete with the transaction
 * memo for settlement attribution. Contract destinations are rejected for
 * the same reason: the required recipient is a Stellar account, not a
 * contract.
 *
 * Memo constraints (Stellar protocol limits):
 * - `text`: at most 28 UTF-8 bytes, valid UTF-8.
 * - `id`: a uint64 (`0` to `2^64 - 1`), given as a decimal string.
 * - `hash` / `return`: exactly 32 bytes.
 * - `none`: no memo value.
 *
 * Transactions whose payload does not decode as a Stellar transaction
 * envelope are not inspected here; the official x402 verifier rejects
 * malformed transaction XDR before any signing takes place. Stellar XDR
 * itself caps memo text at 28 bytes, so an oversized text memo cannot be
 * expressed in a decodable envelope and is rejected as malformed by that
 * verifier. The pure memo validator below still enforces the limit for any
 * memo value presented to it.
 */
export const stellarMemoTypes = ["none", "text", "id", "hash", "return"] as const;

export type StellarMemoType = (typeof stellarMemoTypes)[number];

export type StellarMemoInput = {
  type: StellarMemoType;
  value: string | Uint8Array | null;
};

export type StellarAddressForm = "ed25519" | "muxed" | "contract" | "unknown";

/** Maximum byte length of a Stellar text memo. */
export const maxTextMemoBytes = 28;

/** Largest memo id value: 2^64 - 1. */
export const maxMemoId = (1n << 64n) - 1n;

/** Required byte length of a Stellar hash / return memo. */
export const hashMemoBytes = 32;

/** Sentinel for a payment destination that could not be decoded as an address. */
export const undecodableDestination = "";

export const memoPolicySummary = {
  policy: "memo-and-muxed-account",
  acceptedMemoTypes: [...stellarMemoTypes],
  memoConstraints: {
    textMaxBytes: maxTextMemoBytes,
    idMax: maxMemoId.toString(),
    hashBytes: hashMemoBytes,
    returnBytes: hashMemoBytes
  },
  acceptedDestinations: ["ed25519"],
  rejectedDestinations: ["muxed", "contract", "unknown"],
  rejectedCombinations:
    "Muxed-account (M...) and contract (C...) destinations are rejected with every memo type, including memo none."
} as const;

/**
 * Validate a Stellar memo against the policy constraints.
 * Throws a typed `UNSUPPORTED_MEMO_OR_MUXED_ACCOUNT` error on violation.
 */
export function validateStellarMemo(memo: StellarMemoInput): void {
  switch (memo.type) {
    case "none": {
      if (memo.value !== null && memo.value !== undefined) {
        throw policyError("Memo type none must not carry a value.", {
          memoType: memo.type
        });
      }
      return;
    }
    case "text": {
      const byteLength = memoByteLength(memo.value);
      if (byteLength === undefined) {
        throw policyError("Text memo must be a string or bytes.", {
          memoType: memo.type
        });
      }
      if (byteLength > maxTextMemoBytes) {
        throw policyError(
          `Text memo is ${byteLength} bytes, exceeding the ${maxTextMemoBytes} byte limit.`,
          {
            memoType: memo.type,
            byteLength,
            maxBytes: maxTextMemoBytes
          }
        );
      }
      if (memo.value instanceof Uint8Array && !isValidUtf8(memo.value)) {
        throw policyError("Text memo is not valid UTF-8.", {
          memoType: memo.type
        });
      }
      return;
    }
    case "id": {
      if (typeof memo.value !== "string" || !/^(0|[1-9][0-9]*)$/.test(memo.value)) {
        throw policyError("Memo id must be a decimal uint64 string.", {
          memoType: memo.type
        });
      }
      if (BigInt(memo.value) > maxMemoId) {
        throw policyError("Memo id exceeds the uint64 maximum.", {
          memoType: memo.type,
          maxId: maxMemoId.toString()
        });
      }
      return;
    }
    case "hash":
    case "return": {
      const byteLength = hashMemoByteLength(memo.value);
      if (byteLength === undefined) {
        throw policyError(`${memo.type} memo must be 32 bytes or 64 hex characters.`, {
          memoType: memo.type
        });
      }
      if (byteLength !== hashMemoBytes) {
        throw policyError(
          `${memo.type} memo is ${byteLength} bytes, expected ${hashMemoBytes} bytes.`,
          {
            memoType: memo.type,
            byteLength,
            expectedBytes: hashMemoBytes
          }
        );
      }
      return;
    }
    default: {
      throw policyError(`Unsupported memo type: ${String(memo.type)}.`, {
        memoType: String(memo.type)
      });
    }
  }
}

/** Classify a Stellar address string by its strkey form. */
export function classifyStellarAddress(address: string): StellarAddressForm {
  if (StrKey.isValidEd25519PublicKey(address)) {
    return "ed25519";
  }
  if (StrKey.isValidMed25519PublicKey(address)) {
    return "muxed";
  }
  if (StrKey.isValidContract(address)) {
    return "contract";
  }
  return "unknown";
}

/**
 * Enforce the accepted memo / destination combination table for one payment
 * destination. A `G...` destination accepts any valid memo; every other
 * address form is rejected with every memo type, including memo none.
 */
export function validateMemoAndDestinationCombination(
  memoType: StellarMemoType,
  addressForm: StellarAddressForm,
  destination: string
): void {
  if (addressForm === "ed25519") {
    return;
  }
  if (addressForm === "muxed") {
    throw policyError(
      "Muxed-account (M...) payment destinations are not supported: the exact scheme " +
        "requires the transfer recipient to equal the G-address payTo, so a muxed " +
        "destination can never settle to the required recipient, and the muxed id " +
        "would compete with the transaction memo for settlement attribution.",
      {
        memoType,
        destinationForm: addressForm,
        destination
      }
    );
  }
  if (addressForm === "contract") {
    throw policyError(
      "Contract (C...) payment destinations are not supported: the exact scheme " +
        "requires the transfer recipient to be a Stellar account matching payTo.",
      {
        memoType,
        destinationForm: addressForm,
        destination
      }
    );
  }
  throw policyError("Payment destination address form is not recognized.", {
    memoType,
    destinationForm: addressForm,
    destination
  });
}

export type ExtractedPaymentMemo = {
  memo: StellarMemoInput;
  destinations: string[];
};

/**
 * Decode a base64 Stellar transaction envelope and extract its memo and
 * payment destinations. Returns `undefined` when the payload does not decode
 * as a Stellar transaction envelope. Fee-bump envelopes are unwrapped and
 * the inner transaction is inspected.
 *
 * Destinations are collected from SEP-41 `transfer` invocations (the `to`
 * argument) and from classic payment operations (`payment`,
 * `pathPaymentStrictSend`, `pathPaymentStrictReceive`, `createAccount`,
 * `accountMerge`). A destination that cannot be decoded as an address is
 * reported as an empty string, which classifies as an unknown form.
 */
export function extractPaymentMemoAndDestinations(
  transactionXdr: string,
  networkPassphrase: string
): ExtractedPaymentMemo | undefined {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  } catch {
    return undefined;
  }
  const transaction = "innerTransaction" in parsed ? parsed.innerTransaction : parsed;
  return {
    memo: { type: transaction.memo.type, value: transaction.memo.value },
    destinations: extractDestinations(transaction)
  };
}

/**
 * Enforce the memo and muxed-account policy on a base64 Stellar transaction
 * envelope for the given network. Throws a typed
 * `UNSUPPORTED_MEMO_OR_MUXED_ACCOUNT` error before any verification or
 * signing when the transaction carries an unsupported memo or destination.
 * Transactions that do not decode as Stellar XDR are left to the official
 * x402 verifier, which rejects malformed payloads before signing.
 */
export function assertPaymentMemoPolicy(transactionXdr: string, network: NetworkId): void {
  const extracted = extractPaymentMemoAndDestinations(transactionXdr, stellarPassphrases[network]);
  if (extracted === undefined) {
    return;
  }
  validateStellarMemo(extracted.memo);
  for (const destination of extracted.destinations) {
    validateMemoAndDestinationCombination(
      extracted.memo.type,
      classifyStellarAddress(destination),
      destination
    );
  }
}

function extractDestinations(transaction: Transaction): string[] {
  const destinations: string[] = [];
  for (const operation of transaction.operations) {
    const transferDestination = extractTransferDestination(operation);
    if (transferDestination !== undefined) {
      destinations.push(transferDestination);
    }
    const classicDestination = extractClassicDestination(operation);
    if (classicDestination !== undefined) {
      destinations.push(classicDestination);
    }
  }
  return destinations;
}

function extractTransferDestination(operation: unknown): string | undefined {
  if (typeof operation !== "object" || operation === null) {
    return undefined;
  }
  const candidate = operation as { type?: unknown; func?: unknown };
  if (candidate.type !== "invokeHostFunction") {
    return undefined;
  }
  const invoke = (candidate.func as { invokeContract?: unknown } | undefined)?.invokeContract as
    | { functionName?: unknown; args?: unknown }
    | undefined;
  if (
    invoke === undefined ||
    hostFunctionName(invoke.functionName) !== "transfer" ||
    !Array.isArray(invoke.args)
  ) {
    return undefined;
  }
  if (invoke.args.length !== 3) {
    return undefined;
  }
  try {
    const to = scValToNative(invoke.args[1] as xdr.ScVal);
    return typeof to === "string" ? to : undecodableDestination;
  } catch {
    return undecodableDestination;
  }
}

const classicDestinationOperationTypes = new Set([
  "payment",
  "pathPaymentStrictSend",
  "pathPaymentStrictReceive",
  "createAccount",
  "accountMerge"
]);

/**
 * The parsed invoke-contract function name can be a plain string or an XDR
 * string wrapper carrying the UTF-8 bytes. Normalize both forms.
 */
function hostFunctionName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "bytes" in value) {
    const bytes = (value as { bytes?: unknown }).bytes;
    if (bytes instanceof Uint8Array) {
      return Buffer.from(bytes).toString("utf8");
    }
  }
  return undefined;
}

function extractClassicDestination(operation: unknown): string | undefined {
  if (typeof operation !== "object" || operation === null) {
    return undefined;
  }
  const candidate = operation as { type?: unknown; destination?: unknown };
  if (typeof candidate.type !== "string" || !classicDestinationOperationTypes.has(candidate.type)) {
    return undefined;
  }
  return typeof candidate.destination === "string" ? candidate.destination : undefined;
}

function memoByteLength(value: string | Uint8Array | null): number | undefined {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8");
  }
  if (value instanceof Uint8Array) {
    return value.length;
  }
  return undefined;
}

function hashMemoByteLength(value: string | Uint8Array | null): number | undefined {
  if (value instanceof Uint8Array) {
    return value.length;
  }
  if (typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)) {
    return hashMemoBytes;
  }
  return undefined;
}

function isValidUtf8(value: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
    return true;
  } catch {
    return false;
  }
}

function policyError(message: string, details: Record<string, unknown>): LumenError {
  return new LumenError("UNSUPPORTED_MEMO_OR_MUXED_ACCOUNT", message, {
    details: { policy: memoPolicySummary.policy, ...details }
  });
}
