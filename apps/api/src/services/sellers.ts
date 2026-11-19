import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  LumenError,
  assertSellerNotSuspendedForOperation,
  type Seller,
  type SellerDomain,
  type SellerOperationKind,
  type SellerStatus,
  type SellerSuspensionInfo
} from "@lumenbazaar/shared";
import { assertStellarPublicKey } from "@lumenbazaar/stellar-payments";

import { type AuditLogService } from "./audit.js";

const domainPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/i;

export const createSellerSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  walletAddress: z.string().trim().min(1),
  domain: z.string().trim().toLowerCase().regex(domainPattern, "Domain is invalid.")
});

export type CreateSellerInput = z.output<typeof createSellerSchema>;

export type SellerStore = {
  createSeller: (input: CreateSellerInput) => Promise<Seller>;
  getSeller: (sellerId: string) => Promise<Seller | undefined>;
  findSellerByWallet: (walletAddress: string) => Promise<Seller | undefined>;
  upsertDomainChallenge: (
    sellerId: string,
    domain: string,
    method: SellerDomain["verificationMethod"]
  ) => Promise<SellerDomain>;
  markDomainVerified: (sellerId: string, domain: string) => Promise<Seller>;
  /**
   * Set the seller lifecycle status. Suspending records when and why;
   * reinstating clears both. Implemented by the store so the status change
   * is atomic with the seller row.
   */
  setSellerStatus: (sellerId: string, status: SellerStatus, reason?: string) => Promise<Seller>;
};

export class InMemorySellerStore implements SellerStore {
  private readonly sellers = new Map<string, Seller>();
  private readonly byWallet = new Map<string, string>();
  private readonly domains = new Map<string, SellerDomain>();

  async createSeller(input: CreateSellerInput) {
    if (this.byWallet.has(input.walletAddress)) {
      throw new LumenError("VALIDATION_FAILED", "Seller wallet address already exists.");
    }

    const now = new Date().toISOString();
    const seller: Seller = {
      id: `seller_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      displayName: input.displayName,
      walletAddress: input.walletAddress,
      domain: input.domain,
      domainVerifiedAt: null,
      status: "active",
      suspendedAt: null,
      suspensionReason: null,
      createdAt: now,
      updatedAt: now
    };

    this.sellers.set(seller.id, seller);
    this.byWallet.set(seller.walletAddress, seller.id);

    return seller;
  }

  async getSeller(sellerId: string) {
    return this.sellers.get(sellerId);
  }

  async findSellerByWallet(walletAddress: string) {
    const sellerId = this.byWallet.get(walletAddress);
    return sellerId === undefined ? undefined : this.sellers.get(sellerId);
  }

  async upsertDomainChallenge(
    sellerId: string,
    domain: string,
    method: SellerDomain["verificationMethod"]
  ) {
    const key = `${sellerId}:${domain}`;
    const existing = this.domains.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const now = new Date().toISOString();
    const challenge: SellerDomain = {
      id: `domain_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      sellerId,
      domain,
      verificationMethod: method,
      challengeToken: `lumenbazaar-${randomUUID().replaceAll("-", "")}`,
      verifiedAt: null,
      createdAt: now,
      updatedAt: now
    };

    this.domains.set(key, challenge);
    return challenge;
  }

  async markDomainVerified(sellerId: string, domain: string) {
    const seller = this.sellers.get(sellerId);

    if (seller === undefined || seller.domain !== domain) {
      throw new LumenError("SELLER_NOT_FOUND", "Seller was not found.");
    }

    const now = new Date().toISOString();
    const updated: Seller = {
      ...seller,
      domainVerifiedAt: now,
      updatedAt: now
    };
    const challenge = this.domains.get(`${sellerId}:${domain}`);

    if (challenge !== undefined) {
      this.domains.set(`${sellerId}:${domain}`, {
        ...challenge,
        verifiedAt: now,
        updatedAt: now
      });
    }

    this.sellers.set(sellerId, updated);
    return updated;
  }

  async setSellerStatus(sellerId: string, status: SellerStatus, reason?: string) {
    const seller = this.sellers.get(sellerId);

    if (seller === undefined) {
      throw new LumenError("SELLER_NOT_FOUND", "Seller was not found.");
    }

    const now = new Date().toISOString();
    const updated: Seller = {
      ...seller,
      status,
      suspendedAt: status === "suspended" ? now : null,
      suspensionReason: status === "suspended" ? (reason ?? null) : null,
      updatedAt: now
    };

    this.sellers.set(sellerId, updated);
    return updated;
  }
}

export const verifyDomainSchema = z.object({
  method: z.enum(["well-known", "dns"]).default("well-known"),
  evidence: z.string().optional()
});

export type VerifyDomainResult = {
  sellerId: string;
  domain: string;
  method: SellerDomain["verificationMethod"];
  challengeToken: string;
  challenge: string;
  verified: boolean;
  domainVerifiedAt: string | null;
};

export class SellerService {
  constructor(
    private readonly store: SellerStore = new InMemorySellerStore(),
    private readonly auditLogService?: AuditLogService
  ) {}

  async createSeller(input: unknown) {
    const seller = createSellerSchema.parse(input);
    assertStellarPublicKey(seller.walletAddress, "walletAddress");
    return this.store.createSeller(seller);
  }

  async getSeller(sellerId: string) {
    const seller = await this.store.getSeller(sellerId);

    if (seller === undefined) {
      throw new LumenError("SELLER_NOT_FOUND", "Seller was not found.");
    }

    return seller;
  }

  /** Suspension state for a seller, for the centralized enforcement helpers. */
  async getSellerStatus(sellerId: string): Promise<SellerSuspensionInfo | null> {
    const seller = await this.store.getSeller(sellerId);
    if (seller === undefined) {
      return null;
    }
    return {
      status: seller.status,
      suspendedAt: seller.suspendedAt,
      suspensionReason: seller.suspensionReason
    };
  }

  /**
   * Central enforcement point for service-level writes and paid operations:
   * throws `SELLER_SUSPENDED` when the seller is suspended and the kind is
   * blocked. Reads and recovery pass through.
   */
  async requireActiveSeller(sellerId: string, kind: SellerOperationKind): Promise<void> {
    const seller = await this.getSeller(sellerId);
    assertSellerNotSuspendedForOperation(seller, kind, sellerId);
  }

  /**
   * Suspend a seller (operator action). Takes effect immediately for every
   * entry point: API keys, existing sessions, and queued work are all gated
   * on the stored status, so no per-route change is needed to enforce it.
   */
  async suspendSeller(sellerId: string, reason?: string) {
    const seller = await this.store.setSellerStatus(sellerId, "suspended", reason);

    await this.auditLogService?.record({
      action: "seller.suspended",
      actorType: "system",
      targetId: seller.id,
      targetType: "seller",
      metadata: { reason: reason ?? null, suspendedAt: seller.suspendedAt }
    });

    return seller;
  }

  /** Reinstate a suspended seller. Clears the suspension timestamp and reason. */
  async reinstateSeller(sellerId: string) {
    const seller = await this.store.setSellerStatus(sellerId, "active");

    await this.auditLogService?.record({
      action: "seller.reinstated",
      actorType: "system",
      targetId: seller.id,
      targetType: "seller",
      metadata: {}
    });

    return seller;
  }

  async verifyDomain(sellerId: string, input: unknown): Promise<VerifyDomainResult> {
    const seller = await this.getSeller(sellerId);
    const request = verifyDomainSchema.parse(input);
    const challenge = await this.store.upsertDomainChallenge(
      seller.id,
      seller.domain,
      request.method
    );
    const expectedEvidence = `lumenbazaar-domain-verification=${challenge.challengeToken}`;

    if (request.evidence !== undefined && request.evidence.includes(expectedEvidence)) {
      const verifiedSeller = await this.store.markDomainVerified(seller.id, seller.domain);

      await this.auditLogService?.record({
        action: "seller.domain.verified",
        actorId: seller.id,
        actorType: "seller",
        targetId: challenge.id,
        targetType: "seller_domain",
        metadata: {
          domain: seller.domain,
          method: challenge.verificationMethod,
          verified: true
        }
      });

      return {
        sellerId: seller.id,
        domain: seller.domain,
        method: challenge.verificationMethod,
        challengeToken: challenge.challengeToken,
        challenge: expectedEvidence,
        verified: true,
        domainVerifiedAt: verifiedSeller.domainVerifiedAt
      };
    }

    await this.auditLogService?.record({
      action: "seller.domain.challenge_created",
      actorId: seller.id,
      actorType: "seller",
      targetId: challenge.id,
      targetType: "seller_domain",
      metadata: {
        domain: seller.domain,
        method: challenge.verificationMethod,
        verified: seller.domainVerifiedAt !== null
      }
    });

    return {
      sellerId: seller.id,
      domain: seller.domain,
      method: challenge.verificationMethod,
      challengeToken: challenge.challengeToken,
      challenge: expectedEvidence,
      verified: seller.domainVerifiedAt !== null,
      domainVerifiedAt: seller.domainVerifiedAt
    };
  }

  getStore() {
    return this.store;
  }
}
