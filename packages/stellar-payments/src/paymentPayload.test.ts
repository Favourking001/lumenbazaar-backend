import { describe, expect, it, vi } from "vitest";

import { LumenError, loadConfig } from "@lumenbazaar/shared";
import {
  testAssetContractId,
  testPaymentPayload,
  testPaymentRequest,
  testPaymentRequirement,
  testMalformedPaymentRequest,
  testWrongAssetPaymentRequest,
  testWrongNetworkPaymentRequest,
  testWrongSchemePaymentRequest,
  testWrongVersionPaymentRequest
} from "@lumenbazaar/testkit";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  MuxedAccount,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal
} from "@stellar/stellar-sdk";

import { PaymentVerificationService, SettlementService, type X402StellarAdapter } from "./index.js";
import { parseVerifyPaymentRequest } from "./index.js";

const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });

describe("official x402 v2 Stellar payment model", () => {
  it("parses the official v2 payload and SEP-41 asset requirement", () => {
    expect(parseVerifyPaymentRequest(testPaymentRequest, config)).toMatchObject({
      x402Version: 2,
      network: "stellar:testnet",
      amount: "500000",
      asset: {
        contractId: testAssetContractId,
        decimals: 7
      },
      paymentPayload: {
        accepted: testPaymentRequirement,
        payload: testPaymentPayload.payload
      }
    });
  });

  it.each([
    ["wrong version", "INVALID_PAYMENT_PAYLOAD", testWrongVersionPaymentRequest],
    ["wrong network", "UNSUPPORTED_NETWORK", testWrongNetworkPaymentRequest],
    ["wrong scheme", "INVALID_PAYMENT_PAYLOAD", testWrongSchemePaymentRequest],
    ["wrong asset", "UNSUPPORTED_ASSET", testWrongAssetPaymentRequest],
    ["malformed transaction base64", "INVALID_PAYMENT_PAYLOAD", testMalformedPaymentRequest]
  ])("rejects %s with a stable error", (_name, code, input) => {
    expect(() => parseVerifyPaymentRequest(input, config)).toThrow(LumenError);
    try {
      parseVerifyPaymentRequest(input, config);
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  });

  it("rejects the former custom Stellar exact shape as v1", () => {
    expect(() =>
      parseVerifyPaymentRequest(
        {
          paymentPayload: {
            scheme: "exact",
            network: "stellar:testnet",
            amount: "0.05"
          },
          paymentRequirements: testPaymentRequirement
        },
        config
      )
    ).toThrow("x402 v1 Stellar exact payloads are not supported");
  });
});

const policyCode = "UNSUPPORTED_MEMO_OR_MUXED_ACCOUNT";

function buildTransferTransaction(memo: Memo, to: string) {
  const payer = Keypair.random();
  return new TransactionBuilder(new Account(payer.publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: testAssetContractId,
        function: "transfer",
        args: [
          nativeToScVal(payer.publicKey(), { type: "address" }),
          nativeToScVal(to, { type: "address" }),
          nativeToScVal(500000n, { type: "i128" })
        ]
      })
    )
    .addMemo(memo)
    .setTimeout(60)
    .build()
    .toXDR();
}

function buildPaymentRequest(transactionXdr: string, payTo: string) {
  const paymentRequirements = { ...testPaymentRequirement, payTo };
  return {
    x402Version: 2 as const,
    paymentPayload: {
      x402Version: 2 as const,
      accepted: paymentRequirements,
      payload: { transaction: transactionXdr }
    },
    paymentRequirements
  };
}

describe("memo and muxed-account policy at the payment boundary", () => {
  it.each([
    ["none", Memo.none()],
    ["text", Memo.text("order-123")],
    ["id", Memo.id("99")],
    ["hash", Memo.hash(Buffer.alloc(32, 7))],
    ["return", Memo.return(Buffer.alloc(32, 9))]
  ] as Array<[string, Memo]>)("accepts memo %s with a G-address destination", (_name, memo) => {
    const recipient = Keypair.random();
    const request = buildPaymentRequest(
      buildTransferTransaction(memo, recipient.publicKey()),
      recipient.publicKey()
    );

    expect(parseVerifyPaymentRequest(request, config)).toMatchObject({
      network: "stellar:testnet",
      payTo: recipient.publicKey()
    });
  });

  it.each([
    ["none", Memo.none()],
    ["text", Memo.text("order-123")],
    ["id", Memo.id("99")],
    ["hash", Memo.hash(Buffer.alloc(32, 7))],
    ["return", Memo.return(Buffer.alloc(32, 9))]
  ] as Array<[string, Memo]>)("rejects a muxed destination with memo %s", (_name, memo) => {
    const account = Keypair.random();
    const muxed = new MuxedAccount(new Account(account.publicKey(), "0"), "42");
    const request = buildPaymentRequest(
      buildTransferTransaction(memo, muxed.accountId()),
      account.publicKey()
    );

    expect(() => parseVerifyPaymentRequest(request, config)).toThrowError(
      expect.objectContaining({
        code: policyCode,
        details: expect.objectContaining({
          policy: "memo-and-muxed-account",
          memoType: memo.type,
          destinationForm: "muxed"
        })
      })
    );
  });

  it("rejects a contract destination", () => {
    const contract = StrKey.encodeContract(Buffer.alloc(32, 3));
    const recipient = Keypair.random();
    const request = buildPaymentRequest(
      buildTransferTransaction(Memo.none(), contract),
      recipient.publicKey()
    );

    expect(() => parseVerifyPaymentRequest(request, config)).toThrowError(
      expect.objectContaining({
        code: policyCode,
        details: expect.objectContaining({ destinationForm: "contract" })
      })
    );
  });

  it("rejects a muxed classic payment destination", () => {
    const payer = Keypair.random();
    const account = Keypair.random();
    const muxed = new MuxedAccount(new Account(account.publicKey(), "0"), "42");
    const transaction = new TransactionBuilder(new Account(payer.publicKey(), "0"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET
    })
      .addOperation(
        Operation.payment({
          destination: muxed.accountId(),
          asset: Asset.native(),
          amount: "1"
        })
      )
      .addMemo(Memo.none())
      .setTimeout(60)
      .build()
      .toXDR();
    const request = buildPaymentRequest(transaction, account.publicKey());

    expect(() => parseVerifyPaymentRequest(request, config)).toThrowError(
      expect.objectContaining({ code: policyCode })
    );
  });
});

describe("PaymentVerificationService memo and muxed-account policy", () => {
  it("rejects a muxed destination before the adapter is called", async () => {
    const verifyExact = vi.fn(async () => ({
      valid: true as const,
      adapter: "@x402/stellar" as const
    }));
    const adapter: X402StellarAdapter = { verifyExact };
    const service = new PaymentVerificationService(config, { adapter });

    const account = Keypair.random();
    const muxed = new MuxedAccount(new Account(account.publicKey(), "0"), "42");
    const request = buildPaymentRequest(
      buildTransferTransaction(Memo.text("order-123"), muxed.accountId()),
      account.publicKey()
    );

    await expect(service.verify(request)).rejects.toMatchObject({ code: policyCode });
    expect(verifyExact).not.toHaveBeenCalled();
  });

  it("accepts a valid memo through to the adapter", async () => {
    const verifyExact = vi.fn(async () => ({
      valid: true as const,
      adapter: "@x402/stellar" as const
    }));
    const adapter: X402StellarAdapter = { verifyExact };
    const service = new PaymentVerificationService(config, { adapter });

    const recipient = Keypair.random();
    const request = buildPaymentRequest(
      buildTransferTransaction(Memo.text("order-123"), recipient.publicKey()),
      recipient.publicKey()
    );

    await expect(service.verify(request)).resolves.toMatchObject({
      network: "stellar:testnet",
      status: "verified"
    });
    expect(verifyExact).toHaveBeenCalledTimes(1);
  });
});

describe("SettlementService memo and muxed-account policy", () => {
  it("rejects a muxed destination at settlement before any settlement work", async () => {
    const service = new SettlementService(config);

    const account = Keypair.random();
    const muxed = new MuxedAccount(new Account(account.publicKey(), "0"), "42");
    const request = buildPaymentRequest(
      buildTransferTransaction(Memo.text("order-123"), muxed.accountId()),
      account.publicKey()
    );

    await expect(service.settle(request)).rejects.toMatchObject({ code: policyCode });
  });
});
