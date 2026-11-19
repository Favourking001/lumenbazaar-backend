/**
 * Dependency outage chaos-test harness.
 *
 * Opt-in, deterministic, and fail-closed: scenarios inject failures into the
 * database, Redis, Horizon RPC, and facilitator dependencies and verify that
 * the system under test recovers with no duplicate settlement and no lost job.
 *
 * The harness never targets production endpoints. Every endpoint string the
 * harness accepts is validated by {@link assertTestEndpoint}, which only
 * allows loopback hosts and the public Stellar testnet hosts, and refuses
 * anything else (including Stellar pubnet). All scenario execution runs
 * against caller-supplied fakes (see {@link InMemoryChaosSystem}) — no live
 * service is ever required.
 *
 * Determinism: scenarios are seeded. Timelines use a virtual clock (logical
 * ticks, not wall-clock time) and a seeded PRNG, so running the same scenario
 * with the same seed always produces the identical report.
 *
 * Only synthetic or explicitly public testnet data is used. Never pass
 * secrets, seed phrases, private keys, signed private payloads, or
 * production records to this harness.
 */

export type ChaosDependency = "database" | "redis" | "horizon" | "facilitator";

export const chaosDependencies: readonly ChaosDependency[] = [
  "database",
  "redis",
  "horizon",
  "facilitator"
];

/** Dependencies a job submission needs to be up. Mirrors the worker path. */
const jobDependencies: readonly ChaosDependency[] = ["redis", "database"];

/** Dependencies a settlement needs to be up. Mirrors the worker path. */
const settlementDependencies: readonly ChaosDependency[] = ["database", "facilitator", "horizon"];

/**
 * Hosts the harness is allowed to point at. Loopback hosts are local test
 * services; the two Stellar testnet hosts are explicitly public testnet data.
 * Stellar pubnet (`horizon.stellar.org`, `mainnet.sorobanrpc.com`) and every
 * other host are refused.
 */
const allowedTestEndpointHosts: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "::1",
  "horizon-testnet.stellar.org",
  "soroban-testnet.stellar.org"
];

/** Thrown when an endpoint fails the test-only guard. Fails closed. */
export class ChaosGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChaosGuardError";
  }
}

/** Thrown when an operation is attempted against a failed dependency. */
export class DependencyOutageError extends Error {
  readonly dependency: ChaosDependency;

  constructor(dependency: ChaosDependency) {
    super(`Dependency outage injected for ${dependency}`);
    this.name = "DependencyOutageError";
    this.dependency = dependency;
  }
}

/**
 * Returns true only for URLs that point at a local test service or the
 * public Stellar testnet. Anything else — including pubnet, any other host,
 * non-HTTP(S) schemes, URLs with embedded credentials, and unparseable
 * strings — returns false. Never throws: use {@link assertTestEndpoint} when
 * a refusal must be loud.
 */
export function isAllowedTestEndpoint(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  return allowedTestEndpointHosts.includes(hostname);
}

/**
 * Throws {@link ChaosGuardError} unless the URL is an allowed test endpoint.
 * Use before storing or using any endpoint the harness may point at.
 */
export function assertTestEndpoint(rawUrl: string): void {
  if (!isAllowedTestEndpoint(rawUrl)) {
    throw new ChaosGuardError(
      `Refusing non-test endpoint: ${rawUrl}. Chaos harness endpoints must be ` +
        `localhost/test services or the public Stellar testnet.`
    );
  }
}

/**
 * Deterministic seeded PRNG (mulberry32 over an FNV-1a hash of the seed).
 * The same seed always produces the same sequence.
 */
export function createSeededRandom(seed: string | number): () => number {
  let state: number;
  if (typeof seed === "number") {
    state = seed >>> 0;
  } else {
    let hash = 0x811c9dc5;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    state = hash >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic timestamp for a virtual-clock tick (no wall-clock use). */
export function virtualTimestamp(startIso: string, tick: number, stepMs: number): string {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) {
    throw new ChaosGuardError(`Invalid virtual clock start: ${startIso}`);
  }
  return new Date(start + tick * stepMs).toISOString();
}

/** Deterministic run identifier derived from scenario id and seed only. */
export function createChaosRunId(scenarioId: string, seed: string | number): string {
  const normalized = String(seed).replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  return `chaos_${scenarioId}_${normalized}`;
}

export type ChaosEndpointMap = Partial<Record<ChaosDependency, string>>;

/**
 * Holds the injected failure state for each dependency. Endpoints bound
 * here are validated with {@link assertTestEndpoint} at construction, so a
 * production URL can never be registered. `fail`/`recover` are the only
 * injection points; `requireUp` is what guarded operations call.
 */
export class ChaosFaultInjector {
  private readonly down = new Set<ChaosDependency>();
  private readonly endpoints: ChaosEndpointMap;

  constructor(endpoints: ChaosEndpointMap = {}) {
    for (const url of Object.values(endpoints)) {
      if (url !== undefined) {
        assertTestEndpoint(url);
      }
    }
    this.endpoints = { ...endpoints };
  }

  fail(dependency: ChaosDependency): void {
    this.down.add(dependency);
  }

  recover(dependency: ChaosDependency): void {
    this.down.delete(dependency);
  }

  isDown(dependency: ChaosDependency): boolean {
    return this.down.has(dependency);
  }

  isUp(dependency: ChaosDependency): boolean {
    return !this.down.has(dependency);
  }

  downDependencies(): ChaosDependency[] {
    return chaosDependencies.filter((dependency) => this.down.has(dependency));
  }

  getEndpoint(dependency: ChaosDependency): string | undefined {
    return this.endpoints[dependency];
  }

  /** Throws {@link DependencyOutageError} when the dependency is down. */
  requireUp(dependency: ChaosDependency): void {
    if (this.down.has(dependency)) {
      throw new DependencyOutageError(dependency);
    }
  }

  reset(): void {
    this.down.clear();
  }
}

export type ChaosStep = {
  tick: number;
  dependency: ChaosDependency;
  action: "fail" | "recover";
  note?: string;
};

export type ChaosScenarioDefinition = {
  id: string;
  name: string;
  description: string;
  /** Seed for the PRNG and virtual clock. Same seed => identical report. */
  seed: string | number;
  /** Job ids submitted at the start of the scenario. */
  jobs: string[];
  /** Payment attempt ids settled during the scenario. */
  settlements: string[];
  /** Failure injection steps, applied in tick order. */
  steps: ChaosStep[];
  /** Ticks of recovery/drain time after the last step. Defaults to 2. */
  recoveryTicks?: number;
};

/**
 * Validates a scenario definition before it runs. Fails closed on: empty
 * ids, duplicate job or settlement ids, unsorted or negative ticks,
 * duplicate steps for the same tick/dependency/action, and fail/recover
 * transitions that contradict the dependency's simulated state.
 */
export function validateChaosScenario(definition: ChaosScenarioDefinition): void {
  if (definition.id.trim() === "") {
    throw new ChaosGuardError("Chaos scenario id must not be empty.");
  }
  if (String(definition.seed).trim() === "") {
    throw new ChaosGuardError(`Chaos scenario ${definition.id} must define a seed.`);
  }
  const duplicateJob = findDuplicate(definition.jobs);
  if (duplicateJob !== undefined) {
    throw new ChaosGuardError(
      `Chaos scenario ${definition.id} has duplicate job id: ${duplicateJob}`
    );
  }
  const duplicateSettlement = findDuplicate(definition.settlements);
  if (duplicateSettlement !== undefined) {
    throw new ChaosGuardError(
      `Chaos scenario ${definition.id} has duplicate settlement attempt id: ${duplicateSettlement}`
    );
  }
  const simulated = new Set<ChaosDependency>();
  let previousTick = -1;
  const seenSteps = new Set<string>();
  for (const step of definition.steps) {
    if (!Number.isInteger(step.tick) || step.tick < 0) {
      throw new ChaosGuardError(
        `Chaos scenario ${definition.id} has an invalid tick: ${String(step.tick)}`
      );
    }
    if (step.tick < previousTick) {
      throw new ChaosGuardError(`Chaos scenario ${definition.id} steps must be ordered by tick.`);
    }
    previousTick = step.tick;
    const key = `${step.tick}:${step.dependency}:${step.action}`;
    if (seenSteps.has(key)) {
      throw new ChaosGuardError(`Chaos scenario ${definition.id} repeats step ${key}.`);
    }
    seenSteps.add(key);
    if (step.action === "fail") {
      if (simulated.has(step.dependency)) {
        throw new ChaosGuardError(
          `Chaos scenario ${definition.id} fails ${step.dependency} while it is already down.`
        );
      }
      simulated.add(step.dependency);
    } else {
      if (!simulated.has(step.dependency)) {
        throw new ChaosGuardError(
          `Chaos scenario ${definition.id} recovers ${step.dependency} while it is not down.`
        );
      }
      simulated.delete(step.dependency);
    }
  }
  if (
    definition.recoveryTicks !== undefined &&
    (!Number.isInteger(definition.recoveryTicks) || definition.recoveryTicks < 0)
  ) {
    throw new ChaosGuardError(
      `Chaos scenario ${definition.id} has an invalid recoveryTicks value.`
    );
  }
}

function findDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

/** Observable state of the system under test, used for recovery assertions. */
export type ChaosSystemState = {
  completedJobIds: string[];
  pendingJobIds: string[];
  /** One entry per settlement actually recorded; duplicates are visible. */
  settlementIds: string[];
  settlementByAttempt: Record<string, string>;
};

/**
 * Minimal interface a system under test must implement for the harness.
 * Implementations must be idempotent: submitting the same job twice or
 * settling the same attempt twice must not create a second job or a second
 * settlement. `drain` processes pending work after recovery; `snapshot`
 * reports the state assertions run against.
 */
export type ChaosSystemUnderTest = {
  submitJob: (jobId: string) => void | Promise<void>;
  settlePayment: (attemptId: string) => string | Promise<string>;
  drain: () => void | Promise<void>;
  snapshot: () => ChaosSystemState | Promise<ChaosSystemState>;
};

/**
 * In-memory fake system under test. Settlement ids are derived
 * deterministically from the payment attempt id, so settling the same
 * attempt twice returns the same settlement id and never duplicates.
 * Jobs are retained until `drain` completes them, so none is ever lost.
 * Uses synthetic ids only; no live service is involved.
 */
export class InMemoryChaosSystem implements ChaosSystemUnderTest {
  private readonly jobs = new Map<string, "pending" | "completed">();
  private readonly settlements = new Map<string, string>();

  submitJob(jobId: string): void {
    if (!this.jobs.has(jobId)) {
      this.jobs.set(jobId, "pending");
    }
  }

  settlePayment(attemptId: string): string {
    const existing = this.settlements.get(attemptId);
    if (existing !== undefined) {
      return existing;
    }
    const settlementId = `settlement_${attemptId}`;
    this.settlements.set(attemptId, settlementId);
    return settlementId;
  }

  drain(): void {
    for (const [jobId, status] of this.jobs) {
      if (status === "pending") {
        this.jobs.set(jobId, "completed");
      }
    }
  }

  snapshot(): ChaosSystemState {
    const completedJobIds: string[] = [];
    const pendingJobIds: string[] = [];
    for (const [jobId, status] of this.jobs) {
      if (status === "completed") {
        completedJobIds.push(jobId);
      } else {
        pendingJobIds.push(jobId);
      }
    }
    completedJobIds.sort();
    pendingJobIds.sort();
    const settlementIds = [...this.settlements.values()].sort();
    const settlementByAttempt: Record<string, string> = {};
    for (const [attemptId, settlementId] of [...this.settlements.entries()].sort()) {
      settlementByAttempt[attemptId] = settlementId;
    }
    return { completedJobIds, pendingJobIds, settlementIds, settlementByAttempt };
  }
}

export type ChaosTimelineEventType =
  | "scenario-start"
  | "dependency-failed"
  | "dependency-recovered"
  | "job-submitted"
  | "job-deferred"
  | "job-completed"
  | "settlement-attempted"
  | "settlement-recorded"
  | "settlement-deferred"
  | "settlement-duplicate-blocked"
  | "drain-started"
  | "drain-completed"
  | "scenario-end";

export type ChaosTimelineEvent = {
  tick: number;
  timestamp: string;
  type: ChaosTimelineEventType;
  dependency?: ChaosDependency;
  jobId?: string;
  attemptId?: string;
  settlementId?: string;
  detail?: string;
};

export type ChaosAssertionResult = {
  id: string;
  passed: boolean;
  detail: string;
};

export type ChaosRecoveryEvidence = {
  jobsSubmitted: number;
  jobsCompleted: number;
  jobsRecovered: number;
  settlementsConfirmed: number;
  ticksToRecover: number;
  dependenciesRecovered: ChaosDependency[];
};

export type ChaosReport = {
  scenarioId: string;
  scenarioName: string;
  seed: string | number;
  runId: string;
  deterministic: true;
  startedAt: string;
  completedAt: string;
  timeline: ChaosTimelineEvent[];
  assertions: ChaosAssertionResult[];
  recoveryEvidence: ChaosRecoveryEvidence;
  passed: boolean;
};

export type RunChaosScenarioOptions = {
  injector?: ChaosFaultInjector;
  /** Virtual-clock step in milliseconds. Defaults to 1000. */
  stepMs?: number;
  /** Virtual-clock start. Defaults to the Unix epoch for determinism. */
  startIso?: string;
};

const defaultStartIso = "1970-01-01T00:00:00.000Z";

/**
 * Runs one chaos scenario deterministically against the given system.
 *
 * The runner walks logical ticks: at each tick it applies the scenario's
 * fail/recover steps, retries any job or settlement deferred by an outage,
 * and — once every dependency is back up — drains pending work. Operations
 * whose dependencies are down are deferred and recorded, never executed
 * against a failed dependency. After the drain, the runner asserts no
 * duplicate settlement, no lost job, full recovery, and complete settlement,
 * and captures the failure timeline and recovery evidence as the report.
 */
export async function runChaosScenario(
  definition: ChaosScenarioDefinition,
  system: ChaosSystemUnderTest,
  options: RunChaosScenarioOptions = {}
): Promise<ChaosReport> {
  validateChaosScenario(definition);
  const injector = options.injector ?? new ChaosFaultInjector();
  const stepMs = options.stepMs ?? 1000;
  const startIso = options.startIso ?? defaultStartIso;
  const random = createSeededRandom(definition.seed);
  // Deterministic virtual-clock offset derived from the seed only.
  const startOffsetMs = Math.floor(random() * 1000);
  const clockStart = new Date(Date.parse(startIso) + startOffsetMs).toISOString();

  const timeline: ChaosTimelineEvent[] = [];
  const at = (tick: number): string => virtualTimestamp(clockStart, tick, stepMs);
  const record = (
    tick: number,
    type: ChaosTimelineEventType,
    fields: Partial<Omit<ChaosTimelineEvent, "tick" | "timestamp" | "type">> = {}
  ): void => {
    timeline.push({ tick, timestamp: at(tick), type, ...fields });
  };

  const lastStepTick = definition.steps.reduce((max, step) => Math.max(max, step.tick), 0);
  const recoveryTicks = definition.recoveryTicks ?? 2;
  const finalTick = lastStepTick + recoveryTicks;

  const pendingJobs = new Set<string>(definition.jobs);
  const pendingSettlements = new Set<string>(definition.settlements);
  const submittedJobs = new Set<string>();
  const settledAttempts = new Map<string, string>();
  let jobsRecovered = 0;
  let firstFailureTick: number | undefined;
  let lastRecoveryTick: number | undefined;

  record(0, "scenario-start", {
    detail: `Scenario ${definition.id} started with seed ${String(definition.seed)}.`
  });

  for (let tick = 0; tick <= finalTick; tick += 1) {
    for (const step of definition.steps) {
      if (step.tick !== tick) {
        continue;
      }
      if (step.action === "fail") {
        injector.fail(step.dependency);
        if (firstFailureTick === undefined) {
          firstFailureTick = tick;
        }
        record(tick, "dependency-failed", {
          dependency: step.dependency,
          detail: step.note ?? `Injected outage for ${step.dependency}.`
        });
      } else {
        injector.recover(step.dependency);
        lastRecoveryTick = tick;
        record(tick, "dependency-recovered", {
          dependency: step.dependency,
          detail: step.note ?? `Recovered ${step.dependency}.`
        });
      }
    }

    for (const jobId of [...pendingJobs]) {
      const blocked = jobDependencies.find((dependency) => injector.isDown(dependency));
      if (blocked !== undefined) {
        record(tick, "job-deferred", {
          dependency: blocked,
          jobId,
          detail: `Job ${jobId} deferred: ${blocked} is down.`
        });
        continue;
      }
      await system.submitJob(jobId);
      pendingJobs.delete(jobId);
      submittedJobs.add(jobId);
      record(tick, "job-submitted", { jobId, detail: `Job ${jobId} submitted.` });
    }

    for (const attemptId of [...pendingSettlements]) {
      const blocked = settlementDependencies.find((dependency) => injector.isDown(dependency));
      if (blocked !== undefined) {
        record(tick, "settlement-deferred", {
          dependency: blocked,
          attemptId,
          detail: `Settlement for attempt ${attemptId} deferred: ${blocked} is down.`
        });
        continue;
      }
      record(tick, "settlement-attempted", {
        attemptId,
        detail: `Settlement attempted for ${attemptId}.`
      });
      const settlementId = await system.settlePayment(attemptId);
      const alreadyRecorded = [...settledAttempts.values()].includes(settlementId);
      if (alreadyRecorded) {
        record(tick, "settlement-duplicate-blocked", {
          attemptId,
          settlementId,
          detail: `Duplicate settlement id ${settlementId} for ${attemptId} blocked; attempt stays pending.`
        });
        continue;
      }
      settledAttempts.set(attemptId, settlementId);
      record(tick, "settlement-recorded", {
        attemptId,
        settlementId,
        detail: `Settlement ${settlementId} recorded for ${attemptId}.`
      });
      pendingSettlements.delete(attemptId);
    }

    const allRecovered = injector.downDependencies().length === 0;
    const nothingPending = pendingJobs.size === 0 && pendingSettlements.size === 0;
    if (tick >= lastStepTick && allRecovered && nothingPending) {
      const before = await system.snapshot();
      const pendingBefore = before.pendingJobIds.length;
      record(tick, "drain-started", {
        detail: `Draining ${pendingBefore} pending job(s) after recovery.`
      });
      await system.drain();
      const after = await system.snapshot();
      jobsRecovered = after.completedJobIds.length - before.completedJobIds.length;
      for (const jobId of after.completedJobIds) {
        if (!before.completedJobIds.includes(jobId)) {
          record(tick, "job-completed", { jobId, detail: `Job ${jobId} completed on drain.` });
        }
      }
      record(tick, "drain-completed", {
        detail: `Drain completed; ${after.completedJobIds.length} job(s) completed.`
      });
      break;
    }
  }

  // Retry the drain at the final tick if the loop ended while work remained.
  const state = await system.snapshot();
  const assertions = buildAssertions(definition, state, injector, submittedJobs);
  const passed = assertions.every((assertion) => assertion.passed);

  const ticksToRecover =
    firstFailureTick === undefined || lastRecoveryTick === undefined
      ? 0
      : lastRecoveryTick - firstFailureTick;
  const dependenciesRecovered = chaosDependencies.filter(
    (dependency) =>
      definition.steps.some(
        (step) => step.dependency === dependency && step.action === "recover"
      ) && injector.isUp(dependency)
  );

  record(finalTick, "scenario-end", {
    detail: passed
      ? `Scenario ${definition.id} passed all assertions.`
      : `Scenario ${definition.id} failed assertions.`
  });

  return {
    scenarioId: definition.id,
    scenarioName: definition.name,
    seed: definition.seed,
    runId: createChaosRunId(definition.id, definition.seed),
    deterministic: true,
    startedAt: at(0),
    completedAt: at(finalTick),
    timeline,
    assertions,
    recoveryEvidence: {
      jobsSubmitted: submittedJobs.size,
      jobsCompleted: state.completedJobIds.length,
      jobsRecovered,
      settlementsConfirmed: state.settlementIds.length,
      ticksToRecover,
      dependenciesRecovered
    },
    passed
  };
}

function buildAssertions(
  definition: ChaosScenarioDefinition,
  state: ChaosSystemState,
  injector: ChaosFaultInjector,
  submittedJobs: Set<string>
): ChaosAssertionResult[] {
  const assertions: ChaosAssertionResult[] = [];

  const duplicateSettlement = findDuplicate(state.settlementIds);
  assertions.push({
    id: "no-duplicate-settlement",
    passed: duplicateSettlement === undefined,
    detail:
      duplicateSettlement === undefined
        ? `${state.settlementIds.length} settlement(s) recorded, all unique.`
        : `Duplicate settlement recorded: ${duplicateSettlement}`
  });

  const accountedJobs = new Set([...state.completedJobIds, ...state.pendingJobIds]);
  const lostJobs = definition.jobs.filter((jobId) => !accountedJobs.has(jobId));
  assertions.push({
    id: "no-lost-job",
    passed: lostJobs.length === 0,
    detail:
      lostJobs.length === 0
        ? `${definition.jobs.length} job(s) submitted, all accounted for.`
        : `Lost job(s): ${lostJobs.join(", ")}`
  });

  assertions.push({
    id: "all-jobs-completed-after-recovery",
    passed: state.pendingJobIds.length === 0,
    detail:
      state.pendingJobIds.length === 0
        ? `${state.completedJobIds.length} job(s) completed after recovery.`
        : `${state.pendingJobIds.length} job(s) still pending after recovery: ${state.pendingJobIds.join(", ")}`
  });

  const missingSettlements = definition.settlements.filter(
    (attemptId) => state.settlementByAttempt[attemptId] === undefined
  );
  assertions.push({
    id: "all-settlements-recorded",
    passed:
      missingSettlements.length === 0 &&
      state.settlementIds.length === definition.settlements.length,
    detail:
      missingSettlements.length === 0
        ? `${state.settlementIds.length} settlement(s) recorded for ${definition.settlements.length} attempt(s).`
        : `Missing settlement(s) for attempt(s): ${missingSettlements.join(", ")}`
  });

  const stillDown = injector.downDependencies();
  assertions.push({
    id: "dependencies-recovered",
    passed: stillDown.length === 0,
    detail:
      stillDown.length === 0
        ? "All dependencies recovered."
        : `Still down at end of scenario: ${stillDown.join(", ")}`
  });

  const unsubmitted = definition.jobs.filter((jobId) => !submittedJobs.has(jobId));
  assertions.push({
    id: "all-jobs-submitted",
    passed: unsubmitted.length === 0,
    detail:
      unsubmitted.length === 0
        ? "All jobs were submitted."
        : `Job(s) never submitted: ${unsubmitted.join(", ")}`
  });

  return assertions;
}

/**
 * Runs several scenarios in order and returns one report per scenario.
 * Each scenario gets a fresh system from `createSystem` unless the caller
 * passes a shared one.
 */
export async function runChaosScenarios(
  definitions: readonly ChaosScenarioDefinition[],
  createSystem: () => ChaosSystemUnderTest,
  options: RunChaosScenarioOptions = {}
): Promise<ChaosReport[]> {
  const reports: ChaosReport[] = [];
  for (const definition of definitions) {
    reports.push(await runChaosScenario(definition, createSystem(), options));
  }
  return reports;
}

function scenario(
  id: string,
  name: string,
  description: string,
  seed: string,
  steps: ChaosStep[]
): ChaosScenarioDefinition {
  return {
    id,
    name,
    description,
    seed,
    jobs: ["chaos_job_1", "chaos_job_2", "chaos_job_3"],
    settlements: ["chaos_attempt_1", "chaos_attempt_2"],
    steps,
    recoveryTicks: 2
  };
}

/**
 * Built-in deterministic scenarios. All use synthetic job and attempt ids,
 * fixed seeds, and the in-memory fake system — no live service is involved.
 */
export const chaosScenarios: readonly ChaosScenarioDefinition[] = [
  scenario(
    "database-outage-during-settlement",
    "Database outage during settlement",
    "The database fails while jobs are submitted and settlements are attempted; " +
      "work is deferred until recovery, then drains with no duplicate settlement and no lost job.",
    "chaos-database-1",
    [
      { tick: 1, dependency: "database", action: "fail" },
      { tick: 3, dependency: "database", action: "recover" }
    ]
  ),
  scenario(
    "redis-outage-job-queue",
    "Redis outage on the job queue",
    "Redis fails while jobs are submitted; submissions are deferred until Redis " +
      "recovers, then all jobs complete and none is lost.",
    "chaos-redis-1",
    [
      { tick: 1, dependency: "redis", action: "fail" },
      { tick: 4, dependency: "redis", action: "recover" }
    ]
  ),
  scenario(
    "horizon-outage-reconciliation",
    "Horizon RPC outage during reconciliation",
    "Horizon fails while settlements are attempted; settlement attempts are " +
      "deferred until Horizon recovers, then each attempt settles exactly once.",
    "chaos-horizon-1",
    [
      { tick: 1, dependency: "horizon", action: "fail" },
      { tick: 3, dependency: "horizon", action: "recover" }
    ]
  ),
  scenario(
    "facilitator-outage-settle",
    "Facilitator outage during settle",
    "The facilitator fails while settlements are attempted; attempts are " +
      "deferred until the facilitator recovers, then each attempt settles exactly once.",
    "chaos-facilitator-1",
    [
      { tick: 1, dependency: "facilitator", action: "fail" },
      { tick: 2, dependency: "facilitator", action: "recover" }
    ]
  ),
  scenario(
    "combined-outage",
    "Combined outage of all dependencies",
    "Database, Redis, Horizon, and the facilitator all fail in sequence and " +
      "recover in sequence; the coordinated incident still ends with no " +
      "duplicate settlement and no lost job.",
    "chaos-combined-1",
    [
      { tick: 1, dependency: "database", action: "fail" },
      { tick: 1, dependency: "redis", action: "fail" },
      { tick: 2, dependency: "horizon", action: "fail" },
      { tick: 2, dependency: "facilitator", action: "fail" },
      { tick: 3, dependency: "database", action: "recover" },
      { tick: 4, dependency: "redis", action: "recover" },
      { tick: 5, dependency: "horizon", action: "recover" },
      { tick: 6, dependency: "facilitator", action: "recover" }
    ]
  )
];

/** Returns a built-in scenario by id, or undefined when unknown. */
export function getChaosScenario(id: string): ChaosScenarioDefinition | undefined {
  return chaosScenarios.find((candidate) => candidate.id === id);
}
