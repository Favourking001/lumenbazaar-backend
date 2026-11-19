import { randomUUID } from "node:crypto";

/**
 * Per-tool MCP response size and truncation policy.
 *
 * Large MCP tool results can exhaust transport memory or be truncated
 * without machine-readable context. Every tool result is measured as
 * UTF-8 JSON bytes against a per-tool budget. A result inside its budget
 * is returned unchanged. An oversized result is truncated explicitly:
 * the returned value carries a `truncation` object (original size,
 * budget, what was omitted, and a cursor / artifact reference for the
 * remainder) and stays valid against the tool's output schema.
 *
 * Critical payment evidence (receipts, settlements, transaction hashes,
 * correlation ids, evidence hashes) is never silently removed: evidence
 * fields are preserved verbatim, and when the evidence alone exceeds the
 * budget the call fails explicitly with `McpResponseEvidenceTooLargeError`
 * instead of returning a result with the evidence dropped.
 *
 * Pure functions except for the in-memory artifact store, which holds
 * omitted remainder content for short-lived retrieval. Synthetic or
 * explicitly public testnet data only; no secrets are ever stored here.
 */

export type McpToolResponseName =
  | "list_supported_networks"
  | "search_paid_resources"
  | "inspect_resource"
  | "prepare_payment"
  | "call_paid_resource"
  | "get_payment_receipt"
  | "inspect_budget"
  | "get_response_artifact";

/** Default budget (bytes of UTF-8 JSON) when a tool has no specific budget. */
export const DEFAULT_MCP_RESPONSE_BUDGET_BYTES = 64 * 1024;

/** Per-tool response budgets in UTF-8 JSON bytes. */
export const MCP_RESPONSE_BUDGETS: Readonly<Record<McpToolResponseName, number>> = {
  list_supported_networks: 16 * 1024,
  search_paid_resources: 128 * 1024,
  inspect_resource: 128 * 1024,
  prepare_payment: 32 * 1024,
  call_paid_resource: 256 * 1024,
  get_payment_receipt: 64 * 1024,
  inspect_budget: 16 * 1024,
  get_response_artifact: 128 * 1024
};

/** Largest remainder payload the artifact store will accept (1 MiB). */
export const MCP_RESPONSE_ARTIFACT_MAX_BYTES = 1024 * 1024;

/** How long an artifact remainder stays retrievable (10 minutes). */
export const MCP_RESPONSE_ARTIFACT_TTL_MS = 10 * 60 * 1000;

/** Most omitted entries held per artifact store (bounded memory). */
export const MCP_RESPONSE_ARTIFACT_MAX_ENTRIES = 100;

/** Default maximum size of one streamed JSON chunk (16 KiB). */
export const MCP_RESPONSE_CHUNK_BYTES = 16 * 1024;

export type McpResponsePolicy = {
  defaultBudgetBytes: number;
  budgets: Readonly<Record<string, number>>;
  artifactMaxBytes: number;
  artifactTtlMs: number;
  artifactMaxEntries: number;
  chunkBytes: number;
};

export const defaultMcpResponsePolicy: McpResponsePolicy = {
  defaultBudgetBytes: DEFAULT_MCP_RESPONSE_BUDGET_BYTES,
  budgets: MCP_RESPONSE_BUDGETS,
  artifactMaxBytes: MCP_RESPONSE_ARTIFACT_MAX_BYTES,
  artifactTtlMs: MCP_RESPONSE_ARTIFACT_TTL_MS,
  artifactMaxEntries: MCP_RESPONSE_ARTIFACT_MAX_ENTRIES,
  chunkBytes: MCP_RESPONSE_CHUNK_BYTES
};

export function budgetForTool(policy: McpResponsePolicy, tool: string): number {
  const override = policy.budgets[tool];
  return override !== undefined && Number.isFinite(override) && override > 0
    ? Math.trunc(override)
    : policy.defaultBudgetBytes;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the response policy from the environment. Per-tool overrides use
 * `MCP_RESPONSE_MAX_BYTES_<TOOL>` (upper-cased tool name, e.g.
 * `MCP_RESPONSE_MAX_BYTES_SEARCH_PAID_RESOURCES`); `MCP_RESPONSE_MAX_BYTES`
 * sets the default budget for tools without an override. Invalid or
 * non-positive values fall back to the defaults.
 */
export function resolveMcpResponsePolicy(env: NodeJS.ProcessEnv = process.env): McpResponsePolicy {
  const budgets: Record<string, number> = { ...MCP_RESPONSE_BUDGETS };
  const defaultBudgetBytes = parsePositiveInt(
    env.MCP_RESPONSE_MAX_BYTES,
    DEFAULT_MCP_RESPONSE_BUDGET_BYTES
  );
  for (const tool of Object.keys(MCP_RESPONSE_BUDGETS)) {
    const key = `MCP_RESPONSE_MAX_BYTES_${tool.toUpperCase()}`;
    const override = parsePositiveInt(env[key], budgets[tool] as number);
    budgets[tool] = override;
  }
  return {
    defaultBudgetBytes,
    budgets,
    artifactMaxBytes: parsePositiveInt(
      env.MCP_RESPONSE_ARTIFACT_MAX_BYTES,
      MCP_RESPONSE_ARTIFACT_MAX_BYTES
    ),
    artifactTtlMs: parsePositiveInt(env.MCP_RESPONSE_ARTIFACT_TTL_MS, MCP_RESPONSE_ARTIFACT_TTL_MS),
    artifactMaxEntries: parsePositiveInt(
      env.MCP_RESPONSE_ARTIFACT_MAX_ENTRIES,
      MCP_RESPONSE_ARTIFACT_MAX_ENTRIES
    ),
    chunkBytes: parsePositiveInt(env.MCP_RESPONSE_CHUNK_BYTES, MCP_RESPONSE_CHUNK_BYTES)
  };
}

export function jsonByteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/** Machine-readable truncation metadata attached to a truncated result. */
export type McpTruncationMetadata = {
  truncated: true;
  tool: string;
  budgetBytes: number;
  originalBytes: number;
  truncatedBytes: number;
  omittedItems: number;
  omittedBytes: number;
  droppedFields: string[];
  artifactId?: string;
  cursor?: string;
  reason: "response_exceeds_budget";
};

/** One omitted piece of a truncated result, held for artifact retrieval. */
export type McpOmittedEntry = {
  path: string;
  kind: "array-item" | "field" | "string-tail";
  value: unknown;
};

export type McpArtifactRemainder = {
  tool: string;
  originalBytes: number;
  omitted: McpOmittedEntry[];
};

/**
 * Keys whose whole subtree is payment evidence and must never be dropped
 * or truncated: a receipt, a settlement, or a payment object.
 */
export const MCP_PAYMENT_EVIDENCE_CONTAINERS = ["receipt", "settlement", "payment"] as const;

/**
 * Scalar keys that are payment evidence wherever they appear (transaction
 * hashes, correlation ids, evidence hashes, receipt/payment ids, ledgers).
 */
export const MCP_PAYMENT_EVIDENCE_KEYS = [
  "transactionHash",
  "paymentHash",
  "correlationId",
  "evidenceHash",
  "receiptId",
  "paymentAttemptId",
  "ledger"
] as const;

const evidenceContainerSet = new Set<string>(MCP_PAYMENT_EVIDENCE_CONTAINERS);
const evidenceKeySet = new Set<string>(MCP_PAYMENT_EVIDENCE_KEYS);

/** Collect the dot-paths of every payment-evidence value in `value`. */
export function paymentEvidencePaths(value: unknown): Set<string> {
  const paths = new Set<string>();
  const walk = (node: unknown, path: string, insideEvidence: boolean): void => {
    if (Array.isArray(node)) {
      if (insideEvidence && path.length > 0) paths.add(path);
      node.forEach((item, index) => walk(item, `${path}[${index}]`, insideEvidence));
      return;
    }
    if (typeof node === "object" && node !== null) {
      if (insideEvidence && path.length > 0) paths.add(path);
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const childPath = path.length === 0 ? key : `${path}.${key}`;
        const isEvidence =
          insideEvidence || evidenceContainerSet.has(key) || evidenceKeySet.has(key);
        if (isEvidence) paths.add(childPath);
        walk(child, childPath, isEvidence);
      }
      return;
    }
    if (insideEvidence && path.length > 0) paths.add(path);
  };
  walk(value, "", false);
  return paths;
}

export function hasPaymentEvidence(value: unknown): boolean {
  return paymentEvidencePaths(value).size > 0;
}

/** Extract only the payment-evidence subtree of `value` (undefined if none). */
export function extractPaymentEvidence(value: unknown): unknown {
  const evidence = paymentEvidencePaths(value);
  if (evidence.size === 0) return undefined;
  const pick = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) {
      return node
        .map((item, index) => pick(item, `${path}[${index}]`))
        .filter((item) => item !== undefined);
    }
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const childPath = path.length === 0 ? key : `${path}.${key}`;
        if (!evidence.has(childPath)) continue;
        const picked = pick(child, childPath);
        if (picked !== undefined) out[key] = picked;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }
    return evidence.has(path) ? node : undefined;
  };
  return pick(value, "");
}

/**
 * Thrown when the payment evidence in a result already exceeds the tool's
 * response budget on its own, so no truncated result could keep it. The
 * caller must fail explicitly rather than return a result without evidence.
 */
export class McpResponseEvidenceTooLargeError extends Error {
  readonly tool: string;
  readonly budgetBytes: number;
  readonly evidenceBytes: number;
  readonly originalBytes: number;

  constructor(tool: string, budgetBytes: number, evidenceBytes: number, originalBytes: number) {
    super(
      `Payment evidence (${evidenceBytes} bytes) exceeds the ${tool} response budget of ${budgetBytes} bytes; refusing to return a result without payment evidence.`
    );
    this.name = "McpResponseEvidenceTooLargeError";
    this.tool = tool;
    this.budgetBytes = budgetBytes;
    this.evidenceBytes = evidenceBytes;
    this.originalBytes = originalBytes;
  }
}

export type ApplyMcpResponsePolicyOptions = {
  tool: string;
  policy?: McpResponsePolicy;
  artifacts?: McpResponseArtifactStore;
};

export type ApplyMcpResponsePolicyResult = {
  value: Record<string, unknown>;
  truncated: boolean;
  truncation?: McpTruncationMetadata;
  artifactId?: string;
};

type ShrinkState = {
  omitted: McpOmittedEntry[];
  omittedItems: number;
  omittedBytes: number;
  droppedFields: string[];
};

function isEvidencePath(path: string, evidence: Set<string>): boolean {
  if (evidence.has(path)) return true;
  for (const evidencePath of evidence) {
    if (path.startsWith(`${evidencePath}.`) || path.startsWith(`${evidencePath}[`)) return true;
    if (evidencePath.startsWith(`${path}.`) || evidencePath.startsWith(`${path}[`)) return true;
  }
  return false;
}

function getAtPath(root: unknown, path: string): unknown {
  if (path.length === 0) return root;
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let node: unknown = root;
  for (const part of parts) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function deleteAtPath(root: Record<string, unknown>, path: string): void {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  const last = parts.pop();
  if (last === undefined) return;
  let node: unknown = root;
  for (const part of parts) {
    if (typeof node !== "object" || node === null) return;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === "object" && node !== null && !Array.isArray(node)) {
    delete (node as Record<string, unknown>)[last];
  }
}

type Candidate =
  | { path: string; kind: "array"; size: number }
  | { path: string; kind: "string"; size: number; excess: number }
  | { path: string; kind: "field"; size: number };

function collectCandidates(
  node: unknown,
  path: string,
  evidence: Set<string>,
  excess: number,
  out: Candidate[]
): void {
  if (Array.isArray(node)) {
    if (node.length > 0 && !isEvidencePath(path, evidence)) {
      const last = node[node.length - 1];
      out.push({ path, kind: "array", size: jsonByteSize(last) });
    }
    node.forEach((item, index) =>
      collectCandidates(item, `${path}[${index}]`, evidence, excess, out)
    );
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path.length === 0 ? key : `${path}.${key}`;
      if (typeof child === "string" && child.length > 0 && !isEvidencePath(childPath, evidence)) {
        out.push({ path: childPath, kind: "string", size: jsonByteSize(child), excess });
      } else if (
        typeof child === "object" &&
        child !== null &&
        !Array.isArray(child) &&
        !isEvidencePath(childPath, evidence)
      ) {
        out.push({ path: childPath, kind: "field", size: jsonByteSize(child) });
      }
      collectCandidates(child, childPath, evidence, excess, out);
    }
  }
}

function setStringAtPath(root: Record<string, unknown>, path: string, value: string): void {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  const last = parts.pop();
  if (last === undefined) return;
  let node: unknown = root;
  for (const part of parts) {
    if (typeof node !== "object" || node === null) return;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === "object" && node !== null && !Array.isArray(node)) {
    (node as Record<string, unknown>)[last] = value;
  }
}

/** Shrink `working` in place until it fits `targetBytes` (or nothing removable is left). */
function shrinkToFit(
  working: Record<string, unknown>,
  targetBytes: number,
  evidence: Set<string>,
  state: ShrinkState
): void {
  for (let step = 0; step < 10_000; step += 1) {
    const size = jsonByteSize(working);
    if (size <= targetBytes) return;
    const excess = size - targetBytes;
    const candidates: Candidate[] = [];
    collectCandidates(working, "", evidence, excess, candidates);
    if (candidates.length === 0) return;
    candidates.sort((a, b) => b.size - a.size);
    const candidate = candidates[0] as Candidate;
    if (candidate.kind === "array") {
      const array = getAtPath(working, candidate.path);
      if (!Array.isArray(array) || array.length === 0) return;
      const removed = array.pop();
      state.omitted.push({ path: candidate.path, kind: "array-item", value: removed });
      state.omittedItems += 1;
      state.omittedBytes += jsonByteSize(removed);
    } else if (candidate.kind === "string") {
      const current = getAtPath(working, candidate.path);
      if (typeof current !== "string" || current.length === 0) return;
      // Keep a prefix that covers the excess plus a small slack; one cut.
      const keepChars = Math.max(0, current.length - excess - 8);
      const kept = current.slice(0, keepChars);
      const removed = current.slice(keepChars);
      setStringAtPath(working, candidate.path, kept);
      state.omitted.push({ path: candidate.path, kind: "string-tail", value: removed });
      state.omittedBytes += jsonByteSize(removed);
    } else {
      const removed = getAtPath(working, candidate.path);
      deleteAtPath(working, candidate.path);
      state.droppedFields.push(candidate.path);
      state.omitted.push({ path: candidate.path, kind: "field", value: removed });
      state.omittedBytes += candidate.size;
    }
  }
}

/**
 * Enforce the per-tool response budget on a tool result object.
 *
 * - Inside budget: returned unchanged, `truncated: false`.
 * - Over budget: non-evidence content is shrunk (array tails, long
 *   strings, then whole non-evidence fields) until the result plus its
 *   truncation metadata fits; the remainder is stored in `artifacts`
 *   when one is supplied and referenced by `artifactId`/`cursor`.
 * - Evidence alone over budget: throws `McpResponseEvidenceTooLargeError`.
 */
export function applyMcpResponsePolicy(
  value: Record<string, unknown>,
  options: ApplyMcpResponsePolicyOptions
): ApplyMcpResponsePolicyResult {
  const policy = options.policy ?? defaultMcpResponsePolicy;
  const budgetBytes = budgetForTool(policy, options.tool);
  const originalBytes = jsonByteSize(value);
  if (originalBytes <= budgetBytes) {
    return { value, truncated: false };
  }

  const evidence = paymentEvidencePaths(value);
  const working: Record<string, unknown> = JSON.parse(JSON.stringify(value)) as Record<
    string,
    unknown
  >;
  const state: ShrinkState = { omitted: [], omittedItems: 0, omittedBytes: 0, droppedFields: [] };

  const buildMetadata = (truncatedBytes: number, artifactId?: string, cursor?: string) => {
    const metadata: McpTruncationMetadata = {
      truncated: true,
      tool: options.tool,
      budgetBytes,
      originalBytes,
      truncatedBytes,
      omittedItems: state.omittedItems,
      omittedBytes: state.omittedBytes,
      droppedFields: [...state.droppedFields],
      reason: "response_exceeds_budget"
    };
    if (artifactId !== undefined) metadata.artifactId = artifactId;
    if (cursor !== undefined) metadata.cursor = cursor;
    return metadata;
  };

  // Reserve room for the metadata itself, then shrink the content.
  const reserve = Math.min(1024, Math.floor(budgetBytes / 4));
  shrinkToFit(working, budgetBytes - reserve, evidence, state);

  // If only evidence (plus metadata) remains and it still does not fit, fail.
  const evidenceOnly = extractPaymentEvidence(value);
  const evidenceBytes = evidenceOnly === undefined ? 0 : jsonByteSize(evidenceOnly);
  const fitted: Record<string, unknown> = { ...working, truncation: buildMetadata(0) };
  if (jsonByteSize(fitted) > budgetBytes && jsonByteSize(working) <= evidenceBytes + 64) {
    throw new McpResponseEvidenceTooLargeError(
      options.tool,
      budgetBytes,
      evidenceBytes,
      originalBytes
    );
  }

  let artifactId: string | undefined;
  let cursor: string | undefined;
  if (options.artifacts !== undefined && state.omitted.length > 0) {
    const stored = options.artifacts.store({
      tool: options.tool,
      originalBytes,
      omitted: state.omitted
    });
    if (stored !== null) {
      artifactId = stored;
      cursor = encodeTruncationCursor({ artifactId, tool: options.tool, offset: 0 });
    }
  }

  // Re-fit with the real metadata size so the final value fits the budget.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const metadata = buildMetadata(0, artifactId, cursor);
    const withMetadata: Record<string, unknown> = { ...working, truncation: metadata };
    const truncatedBytes = jsonByteSize(withMetadata);
    if (truncatedBytes <= budgetBytes) {
      // Assigning the real byte count can grow the metadata itself (more
      // digits), so seal it and re-measure until it is self-consistent.
      metadata.truncatedBytes = truncatedBytes;
      const sealedBytes = jsonByteSize(withMetadata);
      if (sealedBytes !== truncatedBytes) metadata.truncatedBytes = sealedBytes;
      if (jsonByteSize(withMetadata) <= budgetBytes) {
        return {
          value: withMetadata,
          truncated: true,
          truncation: metadata,
          ...(artifactId === undefined ? {} : { artifactId })
        };
      }
    }
    shrinkToFit(working, budgetBytes - jsonByteSize(metadata) - 16, evidence, state);
  }

  // Still over budget after re-fitting: only evidence + metadata can remain.
  const finalMetadata = buildMetadata(0, artifactId, cursor);
  const finalValue: Record<string, unknown> = { ...working, truncation: finalMetadata };
  if (jsonByteSize(finalValue) > budgetBytes) {
    throw new McpResponseEvidenceTooLargeError(
      options.tool,
      budgetBytes,
      evidenceBytes,
      originalBytes
    );
  }
  finalMetadata.truncatedBytes = jsonByteSize(finalValue);
  const sealedFinalBytes = jsonByteSize(finalValue);
  if (sealedFinalBytes !== finalMetadata.truncatedBytes) {
    finalMetadata.truncatedBytes = sealedFinalBytes;
  }
  return {
    value: finalValue,
    truncated: true,
    truncation: finalMetadata,
    ...(artifactId === undefined ? {} : { artifactId })
  };
}

// ---------------------------------------------------------------------------
// Truncation cursors and the artifact store
// ---------------------------------------------------------------------------

export type TruncationCursor = {
  artifactId: string;
  tool: string;
  offset: number;
};

export function encodeTruncationCursor(cursor: TruncationCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

export function decodeTruncationCursor(cursor: string): TruncationCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      parsed.v !== 1 ||
      typeof parsed.artifactId !== "string" ||
      typeof parsed.tool !== "string" ||
      typeof parsed.offset !== "number" ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      return null;
    }
    return {
      artifactId: parsed.artifactId,
      tool: parsed.tool,
      offset: parsed.offset
    };
  } catch {
    return null;
  }
}

export type McpResponseArtifactStoreOptions = {
  maxBytes?: number;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

type StoredArtifact = McpArtifactRemainder & { storedAt: number };

/**
 * Short-lived in-memory store for omitted remainder content. Entries
 * expire after `ttlMs` and the store is bounded (`maxEntries`, and each
 * remainder must fit `maxBytes`); oversized or expired remainders are
 * never returned. Nothing here is persisted or sent anywhere else.
 */
export class McpResponseArtifactStore {
  private readonly entries = new Map<string, StoredArtifact>();
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: McpResponseArtifactStoreOptions = {}) {
    this.maxBytes = options.maxBytes ?? MCP_RESPONSE_ARTIFACT_MAX_BYTES;
    this.ttlMs = options.ttlMs ?? MCP_RESPONSE_ARTIFACT_TTL_MS;
    this.maxEntries = options.maxEntries ?? MCP_RESPONSE_ARTIFACT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Store a remainder; returns its artifact id, or null when too large. */
  store(remainder: McpArtifactRemainder): string | null {
    if (jsonByteSize(remainder) > this.maxBytes) return null;
    this.prune();
    if (this.entries.size >= this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
      if (oldest !== undefined) this.entries.delete(oldest[0]);
    }
    const artifactId = randomUUID();
    this.entries.set(artifactId, { ...remainder, storedAt: this.now() });
    return artifactId;
  }

  get(artifactId: string): (McpArtifactRemainder & { storedAt: number }) | undefined {
    this.prune();
    return this.entries.get(artifactId);
  }

  /** Page through the omitted entries of an artifact (cursor offset/limit). */
  getPage(
    artifactId: string,
    offset: number,
    limit: number
  ): {
    items: McpOmittedEntry[];
    totalOmitted: number;
    hasMore: boolean;
    nextCursor: string | null;
  } | null {
    const artifact = this.get(artifactId);
    if (artifact === undefined) return null;
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 100);
    const items = artifact.omitted.slice(safeOffset, safeOffset + safeLimit);
    const hasMore = safeOffset + items.length < artifact.omitted.length;
    return {
      items,
      totalOmitted: artifact.omitted.length,
      hasMore,
      nextCursor: hasMore
        ? encodeTruncationCursor({
            artifactId,
            tool: artifact.tool,
            offset: safeOffset + items.length
          })
        : null
    };
  }

  size(): number {
    this.prune();
    return this.entries.size;
  }

  prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.storedAt > this.ttlMs) this.entries.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Streamed (chunked) JSON responses
// ---------------------------------------------------------------------------

/**
 * Split serialized JSON into chunks of at most `chunkBytes` UTF-8 bytes
 * each, without splitting a UTF-16 surrogate pair. Joining the chunks
 * reproduces the input exactly.
 */
export function chunkJsonText(text: string, chunkBytes: number): string[] {
  if (!Number.isFinite(chunkBytes) || chunkBytes < 1) {
    throw new Error("chunkBytes must be a positive integer");
  }
  const limit = Math.trunc(chunkBytes);
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (currentBytes + charBytes > limit && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

/** Async generator form of `chunkJsonText`, for streamed transports. */
export async function* streamJsonChunks(
  text: string,
  chunkBytes: number
): AsyncGenerator<string, void, void> {
  for (const chunk of chunkJsonText(text, chunkBytes)) {
    yield chunk;
  }
}

/**
 * Serialize a (possibly truncated) tool result for a streamed response:
 * enforce the budget first, then chunk the JSON text. The reassembled
 * text parses to the same schema-valid truncated value the JSON path
 * returns, with its `truncation` metadata intact.
 */
export function serializeTruncatedJsonStream(
  value: Record<string, unknown>,
  options: ApplyMcpResponsePolicyOptions & { chunkBytes?: number }
): { text: string; chunks: string[]; truncated: boolean; truncation?: McpTruncationMetadata } {
  const enforced = applyMcpResponsePolicy(value, options);
  const text = JSON.stringify(enforced.value);
  const chunkBytes = options.chunkBytes ?? options.policy?.chunkBytes ?? MCP_RESPONSE_CHUNK_BYTES;
  return {
    text,
    chunks: chunkJsonText(text, chunkBytes),
    truncated: enforced.truncated,
    ...(enforced.truncation === undefined ? {} : { truncation: enforced.truncation })
  };
}
