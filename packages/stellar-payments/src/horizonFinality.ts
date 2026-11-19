import { LumenError, type AppConfig } from "@lumenbazaar/shared";

/**
 * Bounded Horizon history traversal.
 *
 * Horizon history endpoints (transactions, operations, payments, effects)
 * are paginated through `_links.next` URLs. A malformed or unexpectedly
 * large traversal — a `next` link that cycles, an endless stream of empty
 * pages, or a collection far larger than the caller expects — could
 * otherwise issue unbounded reconciliation requests. This module bounds
 * every traversal by page count, record count, and wall-clock duration,
 * and makes partial progress resumable through a serializable cursor so a
 * stopped traversal can continue without re-fetching records it already
 * processed.
 *
 * Nothing here touches the live network unless the caller supplies a
 * fetcher that does: `traverseHorizonHistory` only calls the injected
 * `fetchPage`, and `fetchHorizonHistoryPage` only calls the injected
 * `fetchFn` (global `fetch` by default). Unit tests stub both.
 *
 * Fail-closed behaviour: an invalid budget, a malformed page, or a
 * Horizon error response aborts the traversal instead of being silently
 * treated as an empty or complete result.
 */

export type HorizonTraversalBudget = {
  /** Maximum number of pages fetched in one traversal. */
  maxPages: number;
  /** Maximum number of unique records returned in one traversal. */
  maxRecords: number;
  /** Maximum wall-clock duration of one traversal, in milliseconds. */
  maxDurationMs: number;
  /** Records requested per page (`limit` sent to Horizon). Horizon caps this at 200. */
  pageSize: number;
};

/**
 * Defaults applied when neither deployment config nor a per-call override
 * supplies a value. A hundred pages of a hundred records is far more than
 * any single reconciliation pass needs, while the 30s duration bound keeps
 * a slow or looping endpoint from holding a worker indefinitely.
 */
export const DEFAULT_HORIZON_TRAVERSAL_BUDGET: Readonly<HorizonTraversalBudget> = {
  maxPages: 100,
  maxRecords: 1000,
  maxDurationMs: 30_000,
  pageSize: 100
};

/** Hard outer bounds a budget may never exceed, even when configured. */
export const HORIZON_TRAVERSAL_HARD_LIMITS: Readonly<HorizonTraversalBudget> = {
  maxPages: 10_000,
  maxRecords: 100_000,
  maxDurationMs: 600_000,
  pageSize: 200
};

export type HorizonTraversalExhaustionReason =
  | "page_budget"
  | "record_budget"
  | "duration_budget"
  | "cyclic_next_link";

/**
 * Serializable resume point for a traversal that stopped before
 * completing. Carries the next unfetched URL plus everything needed to
 * avoid re-processing records or re-entering a cycle: the ids of records
 * already returned, the URLs already fetched, and the counts so far.
 */
export type HorizonTraversalCursor = {
  nextUrl: string;
  seenRecordIds: string[];
  seenUrls: string[];
  pagesFetched: number;
  recordsFetched: number;
};

export type HorizonTraversalMetrics = {
  pagesFetched: number;
  recordsFetched: number;
  duplicateRecordsSkipped: number;
  emptyPages: number;
  durationMs: number;
  completed: boolean;
  exhaustedReason?: HorizonTraversalExhaustionReason;
};

export type HorizonTraversalResult<T> = {
  /** Unique records collected, in traversal order. */
  records: T[];
  pagesFetched: number;
  recordsFetched: number;
  durationMs: number;
  /** True only when the traversal reached the end of the collection. */
  completed: boolean;
  /** Why the traversal stopped early, when it did. */
  exhaustedReason?: HorizonTraversalExhaustionReason;
  /**
   * Resume point when the traversal stopped early with more pages to
   * fetch. Absent when the traversal completed or when there is no next
   * page to resume from.
   */
  resumeCursor?: HorizonTraversalCursor;
  /** Observable summary of the traversal, also reported via `onProgress`. */
  metrics: HorizonTraversalMetrics;
};

/** One page of a Horizon collection response. */
export type HorizonPage<T> = {
  records: readonly T[];
  /** The `_links.next.href` URL, or null/undefined when this is the last page. */
  nextUrl?: string | null;
};

export type HorizonPageFetcher<T> = (url: string) => Promise<HorizonPage<T>>;

export type HorizonTraversalLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

export type TraverseHorizonHistoryOptions<T> = {
  /** URL of the first page to fetch (ignored when resuming from a cursor). */
  startUrl: string;
  fetchPage: HorizonPageFetcher<T>;
  /**
   * Deployment config to read budgets from (`config.settlement.horizonTraversal`).
   * Per-call `budget` overrides win over config, which wins over defaults.
   */
  config?: AppConfig;
  /** Per-call budget overrides. Values must be positive integers within the hard limits. */
  budget?: Partial<HorizonTraversalBudget>;
  /** Cursor from an earlier incomplete traversal to resume from. */
  resumeCursor?: HorizonTraversalCursor;
  /**
   * Extracts a stable identity for a record, used to skip duplicates
   * across pages and across resumes. Defaults to the record's `id` or
   * `paging_token` field; records without either are treated as unique.
   */
  recordId?: (record: T) => string | undefined;
  /** Called after every page and once at the end with the current metrics. */
  onProgress?: (metrics: HorizonTraversalMetrics) => void;
  /** Optional logger for the final traversal summary. Defaults to silent. */
  logger?: HorizonTraversalLogger;
  /** Clock override (tests). Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Resolve the effective traversal budget from defaults, deployment
 * config, and per-call overrides (later sources win). Every value is
 * validated: non-positive, non-integer, or above-hard-limit values fail
 * closed with a `LumenError` instead of being silently clamped, so a
 * misconfiguration is visible at startup/call time rather than quietly
 * changing how much history a traversal may read.
 */
export function resolveHorizonTraversalBudget(
  config?: AppConfig,
  overrides?: Partial<HorizonTraversalBudget>
): HorizonTraversalBudget {
  const configured = config?.settlement.horizonTraversal;
  const merged: HorizonTraversalBudget = {
    maxPages:
      overrides?.maxPages ?? configured?.maxPages ?? DEFAULT_HORIZON_TRAVERSAL_BUDGET.maxPages,
    maxRecords:
      overrides?.maxRecords ??
      configured?.maxRecords ??
      DEFAULT_HORIZON_TRAVERSAL_BUDGET.maxRecords,
    maxDurationMs:
      overrides?.maxDurationMs ??
      configured?.maxDurationMs ??
      DEFAULT_HORIZON_TRAVERSAL_BUDGET.maxDurationMs,
    pageSize: overrides?.pageSize ?? DEFAULT_HORIZON_TRAVERSAL_BUDGET.pageSize
  };

  const entries = [
    ["maxPages", merged.maxPages, HORIZON_TRAVERSAL_HARD_LIMITS.maxPages],
    ["maxRecords", merged.maxRecords, HORIZON_TRAVERSAL_HARD_LIMITS.maxRecords],
    ["maxDurationMs", merged.maxDurationMs, HORIZON_TRAVERSAL_HARD_LIMITS.maxDurationMs],
    ["pageSize", merged.pageSize, HORIZON_TRAVERSAL_HARD_LIMITS.pageSize]
  ] as const;
  for (const [name, value, hardLimit] of entries) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new LumenError(
        "VALIDATION_FAILED",
        `Horizon traversal budget ${name} must be a positive integer.`,
        { details: { stage: "horizon_traversal", budgetField: name } }
      );
    }
    if (value > hardLimit) {
      throw new LumenError(
        "VALIDATION_FAILED",
        `Horizon traversal budget ${name} must not exceed ${hardLimit}.`,
        { details: { stage: "horizon_traversal", budgetField: name, hardLimit } }
      );
    }
  }

  return merged;
}

function defaultRecordId<T>(record: T): string | undefined {
  if (record === null || typeof record !== "object") {
    return undefined;
  }
  const candidate = record as { id?: unknown; paging_token?: unknown };
  if (typeof candidate.id === "string" && candidate.id.length > 0) {
    return candidate.id;
  }
  if (typeof candidate.paging_token === "string" && candidate.paging_token.length > 0) {
    return candidate.paging_token;
  }
  return undefined;
}

/**
 * Traverse a paginated Horizon history collection with bounded page,
 * record, and duration budgets.
 *
 * Termination guarantees:
 * - The loop stops as soon as any budget is reached, and the result
 *   carries a `resumeCursor` so the caller can continue later.
 * - A `next` URL that was already fetched stops the traversal with
 *   reason `cyclic_next_link`; resuming from the returned cursor
 *   re-detects the cycle immediately and fetches nothing.
 * - Empty pages still count against the page budget, so a stream of
 *   empty pages cannot loop forever; an empty final page completes.
 * - Records already seen — within this traversal or in a resumed cursor —
 *   are skipped, never returned twice and never counted twice.
 */
export async function traverseHorizonHistory<T>(
  options: TraverseHorizonHistoryOptions<T>
): Promise<HorizonTraversalResult<T>> {
  const budget = resolveHorizonTraversalBudget(options.config, options.budget);
  const now = options.now ?? Date.now;
  const recordId = options.recordId ?? defaultRecordId;
  const startedAt = now();

  const seenRecordIds = new Set<string>(options.resumeCursor?.seenRecordIds ?? []);
  const seenUrls = new Set<string>(options.resumeCursor?.seenUrls ?? []);
  let pagesFetched = options.resumeCursor?.pagesFetched ?? 0;
  const records: T[] = [];
  let duplicateRecordsSkipped = 0;
  let emptyPages = 0;
  let exhaustedReason: HorizonTraversalExhaustionReason | undefined;
  let nextUrl: string | null | undefined = options.resumeCursor?.nextUrl ?? options.startUrl;

  const buildMetrics = (completed: boolean): HorizonTraversalMetrics => ({
    pagesFetched,
    recordsFetched: records.length,
    duplicateRecordsSkipped,
    emptyPages,
    durationMs: now() - startedAt,
    completed,
    ...(exhaustedReason === undefined ? {} : { exhaustedReason })
  });

  const buildCursor = (url: string): HorizonTraversalCursor => ({
    nextUrl: url,
    seenRecordIds: [...seenRecordIds],
    seenUrls: [...seenUrls],
    pagesFetched,
    recordsFetched: records.length
  });

  const finish = (completed: boolean): HorizonTraversalResult<T> => {
    const metrics = buildMetrics(completed);
    options.onProgress?.(metrics);
    if (options.logger !== undefined) {
      const log = completed ? options.logger.info : options.logger.warn;
      log("Horizon history traversal finished.", {
        ...metrics,
        budget: { ...budget }
      });
    }
    return {
      records,
      pagesFetched,
      recordsFetched: records.length,
      durationMs: metrics.durationMs,
      completed,
      ...(exhaustedReason === undefined ? {} : { exhaustedReason }),
      ...(completed || nextUrl === null || nextUrl === undefined
        ? {}
        : { resumeCursor: buildCursor(nextUrl) }),
      metrics
    };
  };

  while (nextUrl !== null && nextUrl !== undefined) {
    if (pagesFetched >= budget.maxPages) {
      exhaustedReason = "page_budget";
      return finish(false);
    }
    if (records.length >= budget.maxRecords) {
      exhaustedReason = "record_budget";
      return finish(false);
    }
    if (now() - startedAt >= budget.maxDurationMs) {
      exhaustedReason = "duration_budget";
      return finish(false);
    }
    if (seenUrls.has(nextUrl)) {
      exhaustedReason = "cyclic_next_link";
      return finish(false);
    }

    seenUrls.add(nextUrl);
    const page = await options.fetchPage(nextUrl);
    if (
      page === null ||
      typeof page !== "object" ||
      !Array.isArray((page as HorizonPage<T>).records)
    ) {
      throw new LumenError(
        "SETTLEMENT_FAILED",
        "Horizon returned a malformed history page: missing records array.",
        { details: { stage: "horizon_traversal" } }
      );
    }
    pagesFetched += 1;
    if (page.records.length === 0) {
      emptyPages += 1;
    }

    for (const record of page.records) {
      const id = recordId(record);
      if (id !== undefined) {
        if (seenRecordIds.has(id)) {
          duplicateRecordsSkipped += 1;
          continue;
        }
        seenRecordIds.add(id);
      }
      records.push(record);
      if (records.length >= budget.maxRecords) {
        break;
      }
    }

    nextUrl = page.nextUrl ?? null;
    options.onProgress?.(buildMetrics(false));

    if (records.length >= budget.maxRecords && nextUrl !== null) {
      exhaustedReason = "record_budget";
      return finish(false);
    }
    if (nextUrl !== null && now() - startedAt >= budget.maxDurationMs) {
      exhaustedReason = "duration_budget";
      return finish(false);
    }
  }

  return finish(true);
}

/**
 * Build the first-page URL for a Horizon history collection, e.g.
 * `transactions` for an account. The `limit` is the traversal page size
 * and `cursor` is Horizon's paging token for resuming from a known
 * record; both are Horizon's own parameters and distinct from this
 * module's resume cursor, which resumes across whole traversals.
 */
export function buildHorizonHistoryUrl(
  horizonUrl: string,
  resourcePath: string,
  options: { pageSize?: number; cursor?: string; order?: "asc" | "desc" } = {}
): string {
  const base = horizonUrl.replace(/\/+$/, "");
  const path = resourcePath.replace(/^\/+/, "");
  const url = new URL(`${base}/${path}`);
  url.searchParams.set(
    "limit",
    String(options.pageSize ?? DEFAULT_HORIZON_TRAVERSAL_BUDGET.pageSize)
  );
  url.searchParams.set("order", options.order ?? "asc");
  if (options.cursor !== undefined) {
    url.searchParams.set("cursor", options.cursor);
  }
  return url.toString();
}

export type HorizonHistoryPageFetcherOptions = {
  /** Abort deadline per page request, in milliseconds. Defaults to 5 000. */
  timeoutMs?: number;
  /** Fetch implementation override (tests). Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
};

/**
 * Fetch one page of a Horizon history collection over HTTP and validate
 * its shape: `_embedded.records` must be an array and `_links.next.href`,
 * when present, must be a string. Non-2xx responses and malformed bodies
 * fail closed with a `LumenError` instead of yielding a partial page.
 */
export async function fetchHorizonHistoryPage<T>(
  url: string,
  options: HorizonHistoryPageFetcherOptions = {}
): Promise<HorizonPage<T>> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
  } catch {
    throw new LumenError("SETTLEMENT_FAILED", "Horizon history request failed.", {
      details: { stage: "horizon_traversal" }
    });
  }
  if (!response.ok) {
    throw new LumenError(
      "SETTLEMENT_FAILED",
      `Horizon history request returned HTTP ${response.status}.`,
      { details: { stage: "horizon_traversal", httpStatus: response.status } }
    );
  }
  const payload = (await response.json()) as {
    _embedded?: { records?: unknown };
    _links?: { next?: { href?: unknown } };
  };
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Array.isArray(payload._embedded?.records)
  ) {
    throw new LumenError(
      "SETTLEMENT_FAILED",
      "Horizon returned a malformed history page: missing records array.",
      { details: { stage: "horizon_traversal" } }
    );
  }
  const nextHref = payload._links?.next?.href;
  if (nextHref !== undefined && typeof nextHref !== "string") {
    throw new LumenError(
      "SETTLEMENT_FAILED",
      "Horizon returned a malformed history page: invalid next link.",
      { details: { stage: "horizon_traversal" } }
    );
  }
  return {
    records: payload._embedded.records as T[],
    ...(nextHref === undefined || nextHref.length === 0 ? {} : { nextUrl: nextHref })
  };
}
