import { describe, expect, it } from "vitest";

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
  nativeToScVal,
  type xdr
} from "@stellar/stellar-sdk";

import {
  assertPaymentMemoPolicy,
  classifyStellarAddress,
  extractPaymentMemoAndDestinations,
  memoPolicySummary,
  validateMemoAndDestinationCombination,
  validateStellarMemo,
  type StellarMemoInput
} from "./memoPolicy.js";

const assetContractId = "CB256KDRXDO2FYJN3YBYZE5KCU46WIIE67DRP5T7HI45DRH2GM6YOJFS";
const policyCode = "UNSUPPORTED_MEMO_OR_MUXED_ACCOUNT";

function buildTransferTransaction(options: {
  memo: Memo;
  to: string;
  functionName?: string;
  args?: xdr.ScVal[];
}) {
  const payer = Keypair.random();
  const args = options.args ?? [
    nativeToScVal(payer.publicKey(), { type: "address" }),
    nativeToScVal(options.to, { type: "address" }),
    nativeToScVal(500000n, { type: "i128" })
  ];
  return new TransactionBuilder(new Account(payer.publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: assetContractId,
        function: options.functionName ?? "transfer",
        args
      })
    )
    .addMemo(options.memo)
    .setTimeout(60)
    .build()
    .toXDR();
}

function buildPaymentTransaction(destination: string) {
  const payer = Keypair.random();
  return new TransactionBuilder(new Account(payer.publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: "1" }))
    .addMemo(Memo.none())
    .setTimeout(60)
    .build()
    .toXDR();
}

function expectPolicyError(run: () => unknown) {
  expect(run).toThrowError(expect.objectContaining({ code: policyCode }));
}

describe("validateStellarMemo", () => {
  it.each([
    ["none", null],
    ["text", ""],
    ["text", "a".repeat(28)],
    ["text", "é".repeat(14)],
    ["text", Buffer.from("hello")],
    ["id", "0"],
    ["id", "18446744073709551615"],
    ["hash", Buffer.alloc(32, 7)],
    ["hash", "a".repeat(64)],
    ["return", Buffer.alloc(32, 9)],
    ["return", "f".repeat(64)]
  ] as Array<[StellarMemoInput["type"], StellarMemoInput["value"]]>)(
    "accepts valid %s memo",
    (type, value) => {
      expect(() => validateStellarMemo({ type, value })).not.toThrow();
    }
  );

  it("rejects text memo over 28 bytes", () => {
    expectPolicyError(() => validateStellarMemo({ type: "text", value: "a".repeat(29) }));
    // 15 two-byte characters are 30 bytes.
    expectPolicyError(() => validateStellarMemo({ type: "text", value: "é".repeat(15) }));
    expectPolicyError(() => validateStellarMemo({ type: "text", value: Buffer.alloc(29, 97) }));
  });

  it("rejects text memo with invalid UTF-8 bytes", () => {
    expectPolicyError(() =>
      validateStellarMemo({ type: "text", value: Buffer.from([0xff, 0xfe, 0x61]) })
    );
  });

  it("rejects text memo with a non-string, non-bytes value", () => {
    expectPolicyError(() => validateStellarMemo({ type: "text", value: 42 as unknown as string }));
  });

  it("rejects memo none carrying a value", () => {
    expectPolicyError(() => validateStellarMemo({ type: "none", value: "x" as unknown as null }));
  });

  it.each([["-1"], ["18446744073709551616"], ["12a"], [""], [" 42"], ["42 "]] as Array<[string]>)(
    "rejects invalid memo id %s",
    (value) => {
      expectPolicyError(() => validateStellarMemo({ type: "id", value }));
    }
  );

  it("rejects memo id given as a number", () => {
    expectPolicyError(() => validateStellarMemo({ type: "id", value: 42 as unknown as string }));
  });

  it.each([
    ["hash", Buffer.alloc(31, 7)],
    ["hash", Buffer.alloc(33, 7)],
    ["hash", "a".repeat(63)],
    ["hash", "z".repeat(64)],
    ["return", Buffer.alloc(0)],
    ["return", "a".repeat(62)]
  ] as Array<[StellarMemoInput["type"], StellarMemoInput["value"]]>)(
    "rejects malformed %s memo",
    (type, value) => {
      expectPolicyError(() => validateStellarMemo({ type, value }));
    }
  );

  it("rejects an unknown memo type", () => {
    expectPolicyError(() =>
      validateStellarMemo({ type: "binary", value: null } as unknown as StellarMemoInput)
    );
  });
});

describe("classifyStellarAddress", () => {
  it("classifies G, M, and C addresses and rejects garbage", () => {
    const account = Keypair.random();
    const muxed = new MuxedAccount(new Account(account.publicKey(), "0"), "42");
    const contract = StrKey.encodeContract(Buffer.alloc(32, 3));

    expect(classifyStellarAddress(account.publicKey())).toBe("ed25519");
    expect(classifyStellarAddress(muxed.accountId())).toBe("muxed");
    expect(classifyStellarAddress(contract)).toBe("contract");
    expect(classifyStellarAddress("not-an-address")).toBe("unknown");
    expect(classifyStellarAddress("")).toBe("unknown");
  });
});

describe("validateMemoAndDestinationCombination", () => {
  it.each(["none", "text", "id", "hash", "return"] as const)(
    "accepts a G-address destination with memo %s",
    (memoType) => {
      const destination = Keypair.random().publicKey();
      expect(() =>
        validateMemoAndDestinationCombination(memoType, "ed25519", destination)
      ).not.toThrow();
    }
  );

  it.each(["none", "text", "id", "hash", "return"] as const)(
    "rejects a muxed destination with memo %s",
    (memoType) => {
      const account = Keypair.random();
      const destination = new MuxedAccount(new Account(account.publicKey(), "0"), "7").accountId();
      expect(() =>
        validateMemoAndDestinationCombination(memoType, "muxed", destination)
      ).toThrowError(
        expect.objectContaining({
          code: policyCode,
          details: expect.objectContaining({
            policy: "memo-and-muxed-account",
            memoType,
            destinationForm: "muxed",
            destination
          })
        })
      );
    }
  );

  it("rejects contract and unknown destinations", () => {
    const contract = StrKey.encodeContract(Buffer.alloc(32, 3));
    expectPolicyError(() => validateMemoAndDestinationCombination("none", "contract", contract));
    expectPolicyError(() =>
      validateMemoAndDestinationCombination("text", "unknown", "not-an-address")
    );
  });
});

describe("extractPaymentMemoAndDestinations", () => {
  it.each([
    ["none", Memo.none()],
    ["text", Memo.text("order-123")],
    ["id", Memo.id("99")],
    ["hash", Memo.hash(Buffer.alloc(32, 7))],
    ["return", Memo.return(Buffer.alloc(32, 9))]
  ] as Array<[string, Memo]>)("extracts every memo type: %s", (_name, memo) => {
    const recipient = Keypair.random();
    const xdr = buildTransferTransaction({ memo, to: recipient.publicKey() });
    const extracted = extractPaymentMemoAndDestinations(xdr, Networks.TESTNET);

    expect(extracted?.memo.type).toBe(memo.type);
    expect(extracted?.destinations).toEqual([recipient.publicKey()]);
  });

  it("extracts a muxed transfer destination", () => {
    const account = Keypair.random();
    const muxed = new MuxedAccount(new Account(account.publicKey(), "0"), "42");
    const xdr = buildTransferTransaction({ memo: Memo.none(), to: muxed.accountId() });
    const extracted = extractPaymentMemoAndDestinations(xdr, Networks.TESTNET);

    expect(extracted?.destinations).toEqual([muxed.accountId()]);
  });

  it("extracts a contract transfer destination", () => {
    const contract = StrKey.encodeContract(Buffer.alloc(32, 3));
    const xdr = buildTransferTransaction({ memo: Memo.none(), to: contract });
    const extracted = extractPaymentMemoAndDestinations(xdr, Networks.TESTNET);

    expect(extracted?.destinations).toEqual([contract]);
  });

  it("extracts a muxed classic payment destination", () => {
    const account = Keypair.random();
    const muxed = new MuxedAccount(new Account(account.publicKey(), "0"), "42");
    const extracted = extractPaymentMemoAndDestinations(
      buildPaymentTransaction(muxed.accountId()),
      Networks.TESTNET
    );

    expect(extracted?.memo.type).toBe("none");
    expect(extracted?.destinations).toEqual([muxed.accountId()]);
  });

  it("extracts memo and destination from a fee-bump inner transaction", () => {
    const payer = Keypair.random();
    const recipient = Keypair.random();
    const inner = new TransactionBuilder(new Account(payer.publicKey(), "0"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: assetContractId,
          function: "transfer",
          args: [
            nativeToScVal(payer.publicKey(), { type: "address" }),
            nativeToScVal(recipient.publicKey(), { type: "address" }),
            nativeToScVal(500000n, { type: "i128" })
          ]
        })
      )
      .addMemo(Memo.text("inner"))
      .setTimeout(60)
      .build();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      payer.publicKey(),
      BASE_FEE,
      inner,
      Networks.TESTNET
    );
    const extracted = extractPaymentMemoAndDestinations(feeBump.toXDR(), Networks.TESTNET);

    expect(extracted?.memo.type).toBe("text");
    expect(extracted?.destinations).toEqual([recipient.publicKey()]);
  });

  it("skips non-transfer invocations for destinations but still reads the memo", () => {
    const recipient = Keypair.random();
    const xdr = buildTransferTransaction({
      memo: Memo.text("approve"),
      to: recipient.publicKey(),
      functionName: "approve",
      args: [
        nativeToScVal(recipient.publicKey(), { type: "address" }),
        nativeToScVal(500000n, { type: "i128" })
      ]
    });
    const extracted = extractPaymentMemoAndDestinations(xdr, Networks.TESTNET);

    expect(extracted?.memo.type).toBe("text");
    expect(extracted?.destinations).toEqual([]);
  });

  it("returns undefined for payloads that do not decode as Stellar XDR", () => {
    expect(
      extractPaymentMemoAndDestinations(Buffer.from("not-xdr").toString("base64"), Networks.TESTNET)
    ).toBeUndefined();
    expect(extractPaymentMemoAndDestinations("not base64!", Networks.TESTNET)).toBeUndefined();
  });
});

describe("assertPaymentMemoPolicy", () => {
  it.each([
    ["none", Memo.none()],
    ["text", Memo.text("order-123")],
    ["id", Memo.id("99")],
    ["hash", Memo.hash(Buffer.alloc(32, 7))],
    ["return", Memo.return(Buffer.alloc(32, 9))]
  ] as Array<[string, Memo]>)(
    "accepts every memo type with a G-address destination: %s",
    (_name, memo) => {
      const recipient = Keypair.random();
      const xdr = buildTransferTransaction({ memo, to: recipient.publicKey() });

      expect(() => assertPaymentMemoPolicy(xdr, "stellar:testnet")).not.toThrow();
    }
  );

  it.each([
    ["none", Memo.none()],
    ["text", Memo.text("order-123")],
    ["id", Memo.id("99")],
    ["hash", Memo.hash(Buffer.alloc(32, 7))],
    ["return", Memo.return(Buffer.alloc(32, 9))]
  ] as Array<[string, Memo]>)("rejects a muxed destination with memo %s", (_name, memo) => {
    const account = Keypair.random();
    const muxed = new MuxedAccount(new Account(account.publicKey(), "0"), "42");
    const xdr = buildTransferTransaction({ memo, to: muxed.accountId() });

    expect(() => assertPaymentMemoPolicy(xdr, "stellar:testnet")).toThrowError(
      expect.objectContaining({ code: policyCode })
    );
  });

  it("rejects a contract destination", () => {
    const contract = StrKey.encodeContract(Buffer.alloc(32, 3));
    const xdr = buildTransferTransaction({ memo: Memo.none(), to: contract });

    expectPolicyError(() => assertPaymentMemoPolicy(xdr, "stellar:testnet"));
  });

  it("rejects a muxed classic payment destination", () => {
    const account = Keypair.random();
    const muxed = new MuxedAccount(new Account(account.publicKey(), "0"), "42");

    expectPolicyError(() =>
      assertPaymentMemoPolicy(buildPaymentTransaction(muxed.accountId()), "stellar:testnet")
    );
  });

  it("accepts a classic payment to a G-address", () => {
    const recipient = Keypair.random();

    expect(() =>
      assertPaymentMemoPolicy(buildPaymentTransaction(recipient.publicKey()), "stellar:testnet")
    ).not.toThrow();
  });

  it("leaves undecodable payloads to the official verifier", () => {
    expect(() =>
      assertPaymentMemoPolicy(
        Buffer.from("stellar-transaction-xdr").toString("base64"),
        "stellar:testnet"
      )
    ).not.toThrow();
  });

  it("documents the accepted and rejected combinations in one place", () => {
    expect(memoPolicySummary.acceptedMemoTypes).toEqual(["none", "text", "id", "hash", "return"]);
    expect(memoPolicySummary.acceptedDestinations).toEqual(["ed25519"]);
    expect(memoPolicySummary.rejectedDestinations).toEqual(["muxed", "contract", "unknown"]);
  });
});
