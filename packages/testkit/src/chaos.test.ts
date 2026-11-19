import { describe, expect, it } from "vitest";

import {
  assertTestEndpoint,
  ChaosFaultInjector,
  ChaosGuardError,
  chaosScenarios,
  createChaosRunId,
  createSeededRandom,
  DependencyOutageError,
  getChaosScenario,
  InMemoryChaosSystem,
  isAllowedTestEndpoint,
  runChaosScenario,
  runChaosScenarios,
  validateChaosScenario,
  virtualTimestamp,
  type ChaosScenarioDefinition,
  type ChaosSystemState,
  type ChaosSystemUnderTest
} from "./chaos.js";

function baseScenario(overrides: Partial<ChaosScenarioDefinition> = {}): ChaosScenarioDefinition {
  return {
    id: "test-scenario",
    name: "Test scenario",
    description: "Scenario used by harness unit tests.",
    seed: "test-seed-1",
    jobs: ["job_1", "job_2"],
    settlements: ["attempt_1"],
    steps: [
      { tick: 1, dependency: "database", action: "fail" },
      { tick: 2, dependency: "database", action: "recover" }
    ],
    recoveryTicks: 2,
    ...overrides
  };
}

describe("endpoint guard", () => {
  it("allows loopback and public Stellar testnet endpoints", () => {
    expect(isAllowedTestEndpoint("http://localhost:3000")).toBe(true);
    expect(isAllowedTestEndpoint("http://localhost:5432/db")).toBe(true);
    expect(isAllowedTestEndpoint("http://127.0.0.1:6379")).toBe(true);
    expect(isAllowedTestEndpoint("http://[::1]:3000")).toBe(true);
    expect(isAllowedTestEndpoint("https://horizon-testnet.stellar.org")).toBe(true);
    expect(isAllowedTestEndpoint("https://soroban-testnet.stellar.org")).toBe(true);
    expect(isAllowedTestEndpoint("http://api.localhost:3000")).toBe(true);
  });

  it("refuses production endpoints, including Stellar pubnet", () => {
    expect(isAllowedTestEndpoint("https://horizon.stellar.org")).toBe(false);
    expect(isAllowedTestEndpoint("https://mainnet.sorobanrpc.com")).toBe(false);
    expect(isAllowedTestEndpoint("https://example.com")).toBe(false);
    expect(isAllowedTestEndpoint("https://api.stellar.org")).toBe(false);
    expect(isAllowedTestEndpoint("https://horizon-testnet.stellar.org.evil.com")).toBe(false);
  });

  it("refuses non-HTTP schemes, embedded credentials, and unparseable URLs", () => {
    expect(isAllowedTestEndpoint("ftp://localhost:21")).toBe(false);
    expect(isAllowedTestEndpoint("http://user:secret@localhost:3000")).toBe(false);
    expect(isAllowedTestEndpoint("not a url")).toBe(false);
    expect(isAllowedTestEndpoint("")).toBe(false);
  });

  it("assertTestEndpoint throws a ChaosGuardError for refused endpoints", () => {
    expect(() => assertTestEndpoint("https://horizon.stellar.org")).toThrow(ChaosGuardError);
    expect(() => assertTestEndpoint("https://horizon.stellar.org")).toThrow(
      /Refusing non-test endpoint/
    );
    expect(() => assertTestEndpoint("http://localhost:3000")).not.toThrow();
  });
});

describe("ChaosFaultInjector", () => {
  it("refuses a production endpoint at construction and fails closed", () => {
    expect(() => new ChaosFaultInjector({ horizon: "https://horizon.stellar.org" })).toThrow(
      ChaosGuardError
    );
    expect(
      () => new ChaosFaultInjector({ database: "postgresql://db.example.com:5432/app" })
    ).toThrow(ChaosGuardError);
  });

  it("accepts test endpoints and tracks failure state", () => {
    const injector = new ChaosFaultInjector({
      database: "http://localhost:5432",
      horizon: "https://horizon-testnet.stellar.org"
    });
    expect(injector.getEndpoint("horizon")).toBe("https://horizon-testnet.stellar.org");
    expect(injector.isUp("database")).toBe(true);
    injector.fail("database");
    expect(injector.isDown("database")).toBe(true);
    expect(injector.downDependencies()).toEqual(["database"]);
    expect(() => injector.requireUp("database")).toThrow(DependencyOutageError);
    injector.recover("database");
    expect(injector.isUp("database")).toBe(true);
    expect(() => injector.requireUp("database")).not.toThrow();
  });
});

describe("determinism", () => {
  it("seeded PRNG produces the same sequence for the same seed", () => {
    const first = createSeededRandom("chaos-seed");
    const second = createSeededRandom("chaos-seed");
    const third = createSeededRandom("other-seed");
    const firstValues = [first(), first(), first()];
    const secondValues = [second(), second(), second()];
    expect(secondValues).toEqual(firstValues);
    expect([third(), third(), third()]).not.toEqual(firstValues);
  });

  it("virtual clock timestamps depend only on start, tick, and step", () => {
    expect(virtualTimestamp("1970-01-01T00:00:00.000Z", 3, 1000)).toBe("1970-01-01T00:00:03.000Z");
    expect(() => virtualTimestamp("not-a-date", 0, 1000)).toThrow(ChaosGuardError);
  });

  it("run ids are derived from scenario id and seed only", () => {
    expect(createChaosRunId("db-outage", "seed-1")).toBe("chaos_db-outage_seed-1");
    expect(createChaosRunId("db-outage", "seed-1")).toBe(createChaosRunId("db-outage", "seed-1"));
    expect(createChaosRunId("db-outage", "seed-2")).not.toBe(
      createChaosRunId("db-outage", "seed-1")
    );
  });

  it("running the same scenario twice produces identical reports", async () => {
    const definition = baseScenario();
    const first = await runChaosScenario(definition, new InMemoryChaosSystem());
    const second = await runChaosScenario(definition, new InMemoryChaosSystem());
    expect(second).toEqual(first);
  });

  it("a different seed produces a different report", async () => {
    const first = await runChaosScenario(baseScenario(), new InMemoryChaosSystem());
    const second = await runChaosScenario(
      baseScenario({ seed: "test-seed-2" }),
      new InMemoryChaosSystem()
    );
    expect(second.runId).not.toBe(first.runId);
    expect(second.startedAt).not.toBe(first.startedAt);
  });
});

describe("validateChaosScenario", () => {
  it("accepts a well-formed scenario", () => {
    expect(() => validateChaosScenario(baseScenario())).not.toThrow();
  });

  it("rejects empty ids, duplicate jobs, and duplicate settlements", () => {
    expect(() => validateChaosScenario(baseScenario({ id: "  " }))).toThrow(ChaosGuardError);
    expect(() => validateChaosScenario(baseScenario({ jobs: ["a", "a"] }))).toThrow(
      /duplicate job id/
    );
    expect(() => validateChaosScenario(baseScenario({ settlements: ["a", "a"] }))).toThrow(
      /duplicate settlement attempt id/
    );
  });

  it("rejects unsorted steps and contradictory fail/recover transitions", () => {
    expect(() =>
      validateChaosScenario(
        baseScenario({
          steps: [
            { tick: 2, dependency: "database", action: "fail" },
            { tick: 1, dependency: "database", action: "recover" }
          ]
        })
      )
    ).toThrow(/ordered by tick/);
    expect(() =>
      validateChaosScenario(
        baseScenario({
          steps: [
            { tick: 1, dependency: "database", action: "fail" },
            { tick: 2, dependency: "database", action: "fail" }
          ]
        })
      )
    ).toThrow(/already down/);
    expect(() =>
      validateChaosScenario(
        baseScenario({ steps: [{ tick: 1, dependency: "redis", action: "recover" }] })
      )
    ).toThrow(/not down/);
  });
});

describe("InMemoryChaosSystem", () => {
  it("is idempotent: repeat submits and settles never duplicate", () => {
    const system = new InMemoryChaosSystem();
    system.submitJob("job_1");
    system.submitJob("job_1");
    expect(system.settlePayment("attempt_1")).toBe("settlement_attempt_1");
    expect(system.settlePayment("attempt_1")).toBe("settlement_attempt_1");
    const state = system.snapshot();
    expect(state.pendingJobIds).toEqual(["job_1"]);
    expect(state.settlementIds).toEqual(["settlement_attempt_1"]);
    system.drain();
    expect(system.snapshot().completedJobIds).toEqual(["job_1"]);
    expect(system.snapshot().pendingJobIds).toEqual([]);
  });
});

describe("runChaosScenario", () => {
  it("passes a database outage scenario with recovery evidence", async () => {
    const report = await runChaosScenario(baseScenario(), new InMemoryChaosSystem());
    expect(report.passed).toBe(true);
    expect(report.deterministic).toBe(true);
    expect(report.assertions.map((assertion) => assertion.id)).toEqual([
      "no-duplicate-settlement",
      "no-lost-job",
      "all-jobs-completed-after-recovery",
      "all-settlements-recorded",
      "dependencies-recovered",
      "all-jobs-submitted"
    ]);
    expect(report.assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(report.recoveryEvidence).toEqual({
      jobsSubmitted: 2,
      jobsCompleted: 2,
      jobsRecovered: 2,
      settlementsConfirmed: 1,
      ticksToRecover: 1,
      dependenciesRecovered: ["database"]
    });
    const types = report.timeline.map((event) => event.type);
    expect(types).toContain("dependency-failed");
    expect(types).toContain("dependency-recovered");
    // Work was submitted at tick 0, before the tick-1 outage, so nothing is
    // deferred here; deferral is covered by the tick-0 outage test below.
    expect(types).toContain("job-submitted");
    expect(types).toContain("settlement-recorded");
    expect(types).toContain("drain-completed");
    expect(types).toContain("scenario-end");
  });

  it("defers work while a dependency is down and retries after recovery", async () => {
    const report = await runChaosScenario(
      baseScenario({
        steps: [
          { tick: 0, dependency: "redis", action: "fail" },
          { tick: 2, dependency: "redis", action: "recover" }
        ]
      }),
      new InMemoryChaosSystem()
    );
    expect(report.passed).toBe(true);
    const deferred = report.timeline.filter((event) => event.type === "job-deferred");
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred[0]?.dependency).toBe("redis");
  });

  it("fails when a dependency never recovers", async () => {
    const report = await runChaosScenario(
      baseScenario({
        steps: [{ tick: 1, dependency: "database", action: "fail" }]
      }),
      new InMemoryChaosSystem()
    );
    expect(report.passed).toBe(false);
    const recovered = report.assertions.find(
      (assertion) => assertion.id === "dependencies-recovered"
    );
    expect(recovered?.passed).toBe(false);
    expect(recovered?.detail).toContain("database");
  });

  it("detects a duplicate settlement and blocks it", async () => {
    class DuplicatingSystem implements ChaosSystemUnderTest {
      private readonly submitted = new Set<string>();
      private readonly recorded: string[] = [];

      submitJob(jobId: string): void {
        this.submitted.add(jobId);
      }

      settlePayment(): string {
        this.recorded.push("settlement_same");
        return "settlement_same";
      }

      drain(): void {
        // Jobs never complete in this fake, so the report must fail.
      }

      snapshot(): ChaosSystemState {
        return {
          completedJobIds: [],
          pendingJobIds: [...this.submitted],
          settlementIds: [...this.recorded],
          settlementByAttempt: {}
        };
      }
    }
    const report = await runChaosScenario(
      baseScenario({ steps: [], settlements: ["attempt_1", "attempt_2"] }),
      new DuplicatingSystem()
    );
    expect(report.passed).toBe(false);
    const duplicate = report.assertions.find(
      (assertion) => assertion.id === "no-duplicate-settlement"
    );
    expect(duplicate?.passed).toBe(false);
    expect(report.timeline.some((event) => event.type === "settlement-duplicate-blocked")).toBe(
      true
    );
  });

  it("detects a lost job", async () => {
    class DroppingSystem implements ChaosSystemUnderTest {
      private readonly seen = new Set<string>();

      submitJob(jobId: string): void {
        // Drops job_2 entirely: it is never recorded anywhere.
        if (jobId !== "job_2") {
          this.seen.add(jobId);
        }
      }

      settlePayment(attemptId: string): string {
        return `settlement_${attemptId}`;
      }

      drain(): void {
        // Nothing to drain; job_2 is gone.
      }

      snapshot(): ChaosSystemState {
        return {
          completedJobIds: [...this.seen],
          pendingJobIds: [],
          settlementIds: ["settlement_attempt_1"],
          settlementByAttempt: { attempt_1: "settlement_attempt_1" }
        };
      }
    }
    const report = await runChaosScenario(baseScenario({ steps: [] }), new DroppingSystem());
    expect(report.passed).toBe(false);
    const lost = report.assertions.find((assertion) => assertion.id === "no-lost-job");
    expect(lost?.passed).toBe(false);
    expect(lost?.detail).toContain("job_2");
  });
});

describe("built-in scenarios", () => {
  it("defines five scenarios covering each dependency and a combined outage", () => {
    expect(chaosScenarios.map((scenario) => scenario.id)).toEqual([
      "database-outage-during-settlement",
      "redis-outage-job-queue",
      "horizon-outage-reconciliation",
      "facilitator-outage-settle",
      "combined-outage"
    ]);
    expect(getChaosScenario("combined-outage")?.steps).toHaveLength(8);
    expect(getChaosScenario("unknown")).toBeUndefined();
  });

  it("all built-in scenarios pass against the in-memory system", async () => {
    const reports = await runChaosScenarios(chaosScenarios, () => new InMemoryChaosSystem());
    expect(reports).toHaveLength(5);
    for (const report of reports) {
      expect(report.passed).toBe(true);
      expect(report.recoveryEvidence.jobsCompleted).toBe(3);
      expect(report.recoveryEvidence.settlementsConfirmed).toBe(2);
      expect(report.recoveryEvidence.jobsRecovered).toBe(3);
    }
    const combined = reports.find((report) => report.scenarioId === "combined-outage");
    expect(combined?.recoveryEvidence.ticksToRecover).toBe(5);
    expect(combined?.recoveryEvidence.dependenciesRecovered).toEqual([
      "database",
      "redis",
      "horizon",
      "facilitator"
    ]);
  });
});
