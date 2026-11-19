import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodError } from "zod";

import type { PaymentPayload } from "@lumenbazaar/buyer-sdk";
import { type SellerStatusResolver } from "@lumenbazaar/shared";
import {
  applyMcpResponsePolicy,
  McpResponseArtifactStore,
  McpResponseEvidenceTooLargeError,
  resolveMcpResponsePolicy,
  type McpResponsePolicy
} from "@lumenbazaar/shared";

import { BackendClient } from "./client.js";
import {
  McpToolConcurrencyLimiter,
  raceWithCancellation,
  resolveMcpClientKey,
  type McpToolConcurrencyLimits
} from "./concurrency.js";
import {
  CapabilityUnavailableError,
  handleToolError,
  NotFoundError,
  ResponseTooLargeError,
  ValidationError
} from "./errors.js";
import { McpPaymentToolService } from "./paymentTools.js";
import { type McpMetricsService } from "./metrics.js";
import { getToolDefinition, listToolDefinitions, type McpToolCapabilities } from "./tools.js";

export type McpRequestExtra = {
  signal?: AbortSignal;
  sessionId?: string;
  authInfo?: { clientId?: string };
};

export type CreateMcpServerOptions = {
  client?: BackendClient;
  capabilityProvider?: () => Promise<McpToolCapabilities>;
  paymentTools?: McpPaymentToolService;
  metrics?: McpMetricsService;
  /**
   * Optional seller-status resolver. When provided, resources owned by a
   * suspended seller are excluded from `search_paid_resources` results.
   * Paid tools enforce suspension separately in `McpPaymentToolService`.
   */
  resolveSellerStatus?: SellerStatusResolver;
  /** Shared limiter instance; defaults to a new limiter from `concurrencyLimits`. */
  concurrencyLimiter?: McpToolConcurrencyLimiter;
  /** Per-client/global bounds; defaults to 5 per client / 50 global. */
  concurrencyLimits?: Partial<McpToolConcurrencyLimits>;
  /**
   * Override for resolving an authenticated client identity from a tool
   * request. Defaults to the SDK-validated token client ID
   * (`extra.authInfo.clientId`), falling back to the transport session ID
   * and then to a single `anonymous` bucket.
   */
  clientIdentityProvider?: (
    request: unknown,
    extra: McpRequestExtra | undefined
  ) => string | undefined;
  /** Per-tool response budgets. Defaults to `resolveMcpResponsePolicy()` (env). */
  responsePolicy?: McpResponsePolicy;
  /** Artifact store for truncated remainders. A fresh store is created when omitted. */
  artifactStore?: McpResponseArtifactStore;
};

export function createMcpServer(options: CreateMcpServerOptions = {}) {
  const client = options.client ?? new BackendClient();
  const paymentTools =
    options.paymentTools ??
    new McpPaymentToolService({
      client,
      ...(options.resolveSellerStatus === undefined
        ? {}
        : { resolveSellerStatus: options.resolveSellerStatus })
    });
  const capabilityProvider = options.capabilityProvider ?? (() => client.getToolCapabilities());
  const concurrencyLimiter =
    options.concurrencyLimiter ?? new McpToolConcurrencyLimiter(options.concurrencyLimits ?? {});
  const responsePolicy = options.responsePolicy ?? resolveMcpResponsePolicy();
  const artifactStore =
    options.artifactStore ??
    new McpResponseArtifactStore({
      maxBytes: responsePolicy.artifactMaxBytes,
      ttlMs: responsePolicy.artifactTtlMs,
      maxEntries: responsePolicy.artifactMaxEntries
    });
  const server = new Server(
    {
      name: "lumenbazaar",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const capabilities = await capabilityProvider();
    const tools = listToolDefinitions(capabilities).map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: z.toJSONSchema(def.inputSchema),
      outputSchema: z.toJSONSchema(def.outputSchema)
    }));

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: unknown, extra) => {
    const req = request as { params: { name: string; arguments?: Record<string, unknown> } };
    const toolName = req.params.name;
    const requestExtra = extra as McpRequestExtra | undefined;

    try {
      const capabilities = await capabilityProvider();
      const knownTool = getToolDefinition(toolName);
      const toolDefinition = getToolDefinition(toolName, capabilities);

      if (knownTool !== undefined && toolDefinition === undefined) {
        throw new CapabilityUnavailableError();
      }
      if (toolDefinition === undefined) {
        throw new ValidationError("Unknown tool name.");
      }

      const toolInput = toolDefinition.inputSchema.parse(req.params.arguments ?? {}) as Record<
        string,
        unknown
      >;
      const dispatchTool = async (): Promise<Record<string, unknown>> => {
        let result: Record<string, unknown>;

        switch (toolName) {
          case "list_supported_networks": {
            const networks = await client.listNetworks();
            result = {
              networks: networks.map((n) => ({
                id: n.id,
                name: n.name,
                chain: n.chain
              }))
            };
            break;
          }

          case "search_paid_resources": {
            const searchParams = {
              q: toolInput.query as string | undefined,
              type: toolInput.type as "http" | "mcp" | undefined,
              network: toolInput.network as string | undefined,
              asset: toolInput.asset as string | undefined,
              limit: toolInput.limit as number | undefined,
              cursor: toolInput.cursor as string | undefined
            };

            const params: {
              q?: string;
              type?: "http" | "mcp";
              network?: string;
              asset?: string;
              limit?: number;
              cursor?: string;
            } = {};
            if (searchParams.q !== undefined) params.q = searchParams.q;
            if (searchParams.type !== undefined) params.type = searchParams.type;
            if (searchParams.network !== undefined) params.network = searchParams.network;
            if (searchParams.asset !== undefined) params.asset = searchParams.asset;
            if (searchParams.limit !== undefined) params.limit = searchParams.limit;
            if (searchParams.cursor !== undefined) params.cursor = searchParams.cursor;

            const response = await client.searchResources(params);
            const visibleResources =
              options.resolveSellerStatus === undefined
                ? response.resources
                : await filterSuspendedSellersResources(
                    response.resources,
                    options.resolveSellerStatus
                  );
            result = {
              resources: visibleResources.map((r) => ({
                id: r.id,
                name: r.name,
                description: r.description,
                type: r.type,
                url: r.url,
                paymentTerms: r.paymentTerms
              }))
            };
            if (response.cursor !== undefined) {
              result.cursor = response.cursor;
            }
            if (response.total !== undefined) {
              result.total = response.total;
            }
            break;
          }

          case "inspect_resource": {
            const resourceId = toolInput.resourceId as string;
            if (!resourceId) {
              throw new Error("resourceId is required");
            }

            const resource = await client.getResource(resourceId);
            result = {
              id: resource.id,
              name: resource.name,
              description: resource.description,
              type: resource.type,
              url: resource.url
            };
            if (resource.routeTemplate !== undefined) {
              result.routeTemplate = resource.routeTemplate;
            }
            result.inputSchema = resource.inputSchema;
            result.outputSchema = resource.outputSchema;
            result.paymentTerms = resource.paymentTerms;
            break;
          }

          case "prepare_payment": {
            result = await paymentTools.preparePayment({
              resourceId: toolInput.resourceId as string
            });
            break;
          }

          case "call_paid_resource": {
            result = await paymentTools.callPaidResource({
              ...(toolInput.body === undefined
                ? {}
                : { body: toolInput.body as Record<string, unknown> }),
              ...(toolInput.maxRetries === undefined
                ? {}
                : { maxRetries: toolInput.maxRetries as number }),
              ...(toolInput.method === undefined
                ? {}
                : { method: toolInput.method as "GET" | "POST" }),
              paymentPayload: toolInput.paymentPayload as PaymentPayload,
              ...(toolInput.retryDelayMs === undefined
                ? {}
                : { retryDelayMs: toolInput.retryDelayMs as number }),
              ...(toolInput.timeoutMs === undefined
                ? {}
                : { timeoutMs: toolInput.timeoutMs as number }),
              resourceId: toolInput.resourceId as string
            });
            break;
          }

          case "get_payment_receipt": {
            result = await paymentTools.getPaymentReceipt({
              receiptId: toolInput.receiptId as string
            });
            break;
          }

          case "inspect_budget": {
            result = paymentTools.inspectBudget();
            break;
          }

          case "get_response_artifact": {
            const artifactId = toolInput.artifactId as string;
            const artifact = artifactStore.get(artifactId);
            if (artifact === undefined) {
              throw new NotFoundError("Response artifact not found or expired.", { artifactId });
            }
            const page = artifactStore.getPage(
              artifactId,
              toolInput.offset as number,
              toolInput.limit as number
            );
            if (page === null) {
              throw new NotFoundError("Response artifact not found or expired.", { artifactId });
            }
            result = {
              artifactId,
              tool: artifact.tool,
              storedAt: artifact.storedAt,
              truncated: true,
              totalOmitted: page.totalOmitted,
              hasMore: page.hasMore,
              items: page.items
            };
            if (page.nextCursor !== null) {
              result.nextCursor = page.nextCursor;
            }
            break;
          }

          default:
            throw new ValidationError("Unknown tool name.");
        }

        return result;
      };

      // Concurrency bounds are separate from the HTTP request-rate limit.
      // Acquire after validation so rejected calls consume no capacity, and
      // release in `finally` so cancelled or failed calls free their slot.
      // A limit breach throws before any tool work starts, so a rejected
      // paid call never enters the payment flow and cannot charge twice;
      // an accepted paid call runs the unchanged idempotent payment flow
      // and its receipt stays reconcilable via get_payment_receipt.
      const providedIdentity = options.clientIdentityProvider?.(request, requestExtra);
      const clientKey = resolveMcpClientKey({
        ...(requestExtra?.authInfo?.clientId !== undefined || providedIdentity !== undefined
          ? { clientId: requestExtra?.authInfo?.clientId ?? providedIdentity }
          : {}),
        ...(requestExtra?.sessionId !== undefined ? { sessionId: requestExtra.sessionId } : {})
      });
      const release = concurrencyLimiter.acquireOrThrow(clientKey);
      let result: Record<string, unknown>;
      try {
        result = await raceWithCancellation(dispatchTool(), requestExtra?.signal);
      } finally {
        release();
      }

      const output = toolDefinition.outputSchema.parse(result) as Record<string, unknown>;
      // Enforce the per-tool response budget. Oversized results are
      // truncated explicitly with machine-readable truncation metadata
      // (and an artifact/cursor for the remainder); payment evidence is
      // never silently removed — when it alone exceeds the budget the
      // call fails explicitly with RESPONSE_TOO_LARGE instead.
      let enforcedOutput: Record<string, unknown>;
      try {
        enforcedOutput = applyMcpResponsePolicy(output, {
          tool: toolName,
          policy: responsePolicy,
          artifacts: artifactStore
        }).value;
      } catch (error) {
        if (error instanceof McpResponseEvidenceTooLargeError) {
          throw new ResponseTooLargeError(
            error.tool,
            error.budgetBytes,
            error.evidenceBytes,
            error.originalBytes
          );
        }
        throw error;
      }
      // The truncated value must still satisfy the tool's output schema.
      const finalOutput = toolDefinition.outputSchema.parse(enforcedOutput) as Record<
        string,
        unknown
      >;
      options.metrics?.recordTool(toolName, "success");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(finalOutput, null, 2)
          }
        ],
        structuredContent: finalOutput
      };
    } catch (error) {
      options.metrics?.recordTool(
        toolName,
        error instanceof CapabilityUnavailableError ? "unavailable" : "error"
      );
      const errorInfo = handleToolError(
        error instanceof ZodError
          ? new ValidationError("Tool input or output did not match its schema.", {
              issues: error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message
              }))
            })
          : error
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: errorInfo.code,
                message: errorInfo.message,
                details: errorInfo.details
              },
              null,
              2
            )
          }
        ],
        isError: true
      };
    }
  });

  return server;
}

/**
 * Exclude resources owned by suspended sellers from search results so a
 * suspended seller cannot be reached for a new paid call through MCP
 * discovery. Resources without a seller id are left visible.
 */
async function filterSuspendedSellersResources(
  resources: Array<Record<string, unknown>>,
  resolveSellerStatus: SellerStatusResolver
): Promise<Array<Record<string, unknown>>> {
  const sellerIds = [
    ...new Set(
      resources
        .map((resource) => resource.sellerId)
        .filter((sellerId): sellerId is string => typeof sellerId === "string")
    )
  ];
  const suspended = new Set(
    (
      await Promise.all(
        sellerIds.map(async (sellerId) => {
          const info = await resolveSellerStatus(sellerId);
          return info?.status === "suspended" ? sellerId : null;
        })
      )
    ).filter((sellerId): sellerId is string => sellerId !== null)
  );
  return resources.filter(
    (resource) => typeof resource.sellerId !== "string" || !suspended.has(resource.sellerId)
  );
}

export function mcpToolSchemaDocument(capabilities: McpToolCapabilities) {
  return {
    schemaVersion: 1,
    service: "lumenbazaar",
    tools: listToolDefinitions(capabilities).map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: z.toJSONSchema(definition.inputSchema),
      outputSchema: z.toJSONSchema(definition.outputSchema)
    }))
  };
}
