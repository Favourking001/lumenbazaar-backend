import { type FastifyInstance } from "fastify";
import { z } from "zod";

import { assertSellerActiveForOperation, type SellerStatusResolver } from "@lumenbazaar/shared";
import { type PaymentSessionService } from "@lumenbazaar/stellar-payments";

import { parseBody, parseParams } from "../http/validation.js";

export type PaymentSessionRouteOptions = {
  paymentSessionService: PaymentSessionService;
  /**
   * When provided, creating a new payment session is blocked for suspended
   * sellers (paid). Settling an already-open session stays allowed
   * (recovery: the buyer's funds are already committed), and reads stay
   * allowed.
   */
  resolveSellerStatus?: SellerStatusResolver;
  /** Resolves the owning seller of a resource for the create-session check. */
  resolveResourceSeller?: (resourceId: string) => Promise<string | undefined>;
};

export function registerPaymentSessionRoutes(
  app: FastifyInstance,
  options: PaymentSessionRouteOptions
) {
  app.post("/v1/payment-sessions", async (request) => {
    const body = parseBody(request, z.unknown());
    if (options.resolveSellerStatus !== undefined) {
      const sellerId = extractSellerId(body);
      if (sellerId !== undefined) {
        await assertSellerActiveForOperation(options.resolveSellerStatus, sellerId, "paid");
      } else {
        const resourceId = extractResourceId(body);
        if (resourceId !== undefined && options.resolveResourceSeller !== undefined) {
          const owner = await options.resolveResourceSeller(resourceId);
          if (owner !== undefined) {
            await assertSellerActiveForOperation(options.resolveSellerStatus, owner, "paid");
          }
        }
      }
    }
    return options.paymentSessionService.createSession(body);
  });

  app.get("/v1/payment-sessions/:sessionId", async (request) => {
    const params = parseParams(request, z.object({ sessionId: z.string().min(1) }));
    return options.paymentSessionService.getSession(params.sessionId);
  });

  app.post("/v1/payment-sessions/:sessionId/settle", async (request) => {
    const params = parseParams(request, z.object({ sessionId: z.string().min(1) }));
    const body = parseBody(request, z.record(z.string(), z.unknown()));

    return options.paymentSessionService.settleSession({
      ...body,
      sessionId: params.sessionId
    });
  });
}

function extractSellerId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const sellerId = (body as Record<string, unknown>).sellerId;
  return typeof sellerId === "string" && sellerId.length > 0 ? sellerId : undefined;
}

function extractResourceId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const resourceId = (body as Record<string, unknown>).resourceId;
  return typeof resourceId === "string" && resourceId.length > 0 ? resourceId : undefined;
}
