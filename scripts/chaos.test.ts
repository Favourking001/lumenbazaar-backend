import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChaosGuardError } from "../packages/testkit/src/chaos.js";
import { parseChaosArgs, runChaosCli, selectChaosScenarios } from "./chaos.js";

describe("parseChaosArgs", () => {
  it("defaults to all scenarios without opting in", () => {
    const options = parseChaosArgs([]);
    expect(options.scenarioId).toBe("all");
    expect(options.optIn).toBe(false);
    expect(options.endpoints).toEqual({});
  });

  it("parses opt-in, scenario, seed, output, and endpoints", () => {
    const options = parseChaosArgs([
      "--opt-in",
      "--scenario",
      "redis-outage-job-queue",
      "--seed",
      "cli-seed",
      "--endpoint",
      "horizon=https://horizon-testnet.stellar.org",
      "--output",
      "chaos-evidence/report.json"
    ]);
    expect(options.optIn).toBe(true);
    expect(options.scenarioId).toBe("redis-outage-job-queue");
    expect(options.seed).toBe("cli-seed");
    expect(options.outputPath).toBe("chaos-evidence/report.json");
    expect(options.endpoints).toEqual({
      horizon: "https://horizon-testnet.stellar.org"
    });
  });

  it("ignores a bare -- separator forwarded by pnpm", () => {
    const options = parseChaosArgs(["--", "--opt-in", "--scenario", "combined-outage"]);
    expect(options.optIn).toBe(true);
    expect(options.scenarioId).toBe("combined-outage");
  });

  it("rejects unknown arguments and missing values", () => {
    expect(() => parseChaosArgs(["--nope"])).toThrow(/Unknown argument/);
    expect(() => parseChaosArgs(["--scenario"])).toThrow(/requires a value/);
    expect(() => parseChaosArgs(["--endpoint", "database"])).toThrow(/Invalid --endpoint/);
    expect(() => parseChaosArgs(["--endpoint", "unknown=http://localhost:5432"])).toThrow(
      /Invalid --endpoint/
    );
  });
});

describe("selectChaosScenarios", () => {
  it("selects all built-in scenarios and single scenarios by id", () => {
    expect(selectChaosScenarios("all")).toHaveLength(5);
    expect(selectChaosScenarios("combined-outage")).toHaveLength(1);
    expect(() => selectChaosScenarios("nope")).toThrow(/Unknown chaos scenario/);
  });
});

describe("runChaosCli", () => {
  it("refuses to run without opting in", async () => {
    await expect(runChaosCli({})).rejects.toThrow(/opt-in/);
  });

  it("runs all scenarios and passes against the in-memory system", async () => {
    const result = await runChaosCli({ optIn: true });
    expect(result.passed).toBe(true);
    expect(result.reports).toHaveLength(5);
    expect(result.reports.every((report) => report.passed)).toBe(true);
  });

  it("runs a single scenario and applies a seed override", async () => {
    const result = await runChaosCli({
      optIn: true,
      scenarioId: "facilitator-outage-settle",
      seed: "cli-seed-override"
    });
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.runId).toBe("chaos_facilitator-outage-settle_cli-seed-override");
    expect(result.passed).toBe(true);
  });

  it("writes a JSON report when an output path is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chaos-cli-"));
    const outputPath = join(dir, "report.json");
    const result = await runChaosCli({
      optIn: true,
      scenarioId: "horizon-outage-reconciliation",
      outputPath
    });
    expect(result.outputPaths).toEqual([outputPath]);
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it("refuses a production endpoint before running anything", async () => {
    await expect(
      runChaosCli({
        optIn: true,
        endpoints: { horizon: "https://horizon.stellar.org" }
      })
    ).rejects.toThrow(ChaosGuardError);
  });
});
