import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ChaosFaultInjector,
  chaosScenarios,
  getChaosScenario,
  InMemoryChaosSystem,
  runChaosScenario,
  type ChaosDependency,
  type ChaosEndpointMap,
  type ChaosReport,
  type ChaosScenarioDefinition
} from "../packages/testkit/src/chaos.js";

/**
 * Opt-in chaos-test harness runner.
 *
 * Runs the deterministic dependency-outage scenarios from the testkit
 * against the in-memory fake system — no live service is ever contacted.
 * Refuses to run unless the operator explicitly opts in with `--opt-in`
 * (or `CHAOS_HARNESS_OPT_IN=1`), and refuses any `--endpoint` value that
 * is not a localhost/test service or the public Stellar testnet.
 *
 * Usage:
 *   pnpm chaos -- --opt-in [--scenario <id|all>] [--seed <value>]
 *     [--endpoint <dependency>=<url>] [--output <path>]
 */

export type ChaosCliOptions = {
  optIn: boolean;
  scenarioId: string;
  seed?: string;
  endpoints: ChaosEndpointMap;
  outputPath?: string;
};

export type ChaosCliResult = {
  passed: boolean;
  reports: ChaosReport[];
  outputPaths: string[];
};

const defaultOptions: ChaosCliOptions = {
  optIn: false,
  scenarioId: "all",
  endpoints: {}
};

const chaosDependencyNames: readonly ChaosDependency[] = [
  "database",
  "redis",
  "horizon",
  "facilitator"
];

export function parseChaosArgs(argv: readonly string[]): ChaosCliOptions {
  const options: ChaosCliOptions = {
    ...defaultOptions,
    endpoints: {},
    optIn: process.env.CHAOS_HARNESS_OPT_IN === "1"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      // Bare separator forwarded by pnpm (`pnpm chaos -- --opt-in`).
      continue;
    } else if (arg === "--opt-in") {
      options.optIn = true;
    } else if (arg === "--scenario") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--scenario requires a value (a scenario id or 'all').");
      }
      options.scenarioId = value;
      i += 1;
    } else if (arg === "--seed") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--seed requires a value.");
      }
      options.seed = value;
      i += 1;
    } else if (arg === "--output") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--output requires a path.");
      }
      options.outputPath = value;
      i += 1;
    } else if (arg === "--endpoint") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--endpoint requires a <dependency>=<url> value.");
      }
      const equals = value.indexOf("=");
      if (equals <= 0) {
        throw new Error(`Invalid --endpoint value: ${value}. Expected <dependency>=<url>.`);
      }
      const dependency = value.slice(0, equals);
      const url = value.slice(equals + 1);
      if (!chaosDependencyNames.includes(dependency as ChaosDependency) || url.trim() === "") {
        throw new Error(
          `Invalid --endpoint value: ${value}. Dependency must be one of ${chaosDependencyNames.join(", ")}.`
        );
      }
      options.endpoints[dependency as ChaosDependency] = url;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new ChaosHelpRequested();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export class ChaosHelpRequested extends Error {
  constructor() {
    super(chaosUsage);
    this.name = "ChaosHelpRequested";
  }
}

export const chaosUsage = [
  "Usage: pnpm chaos -- --opt-in [--scenario <id|all>] [--seed <value>]",
  "  [--endpoint <dependency>=<url>] [--output <path>]",
  "",
  "Scenarios:",
  ...chaosScenarios.map((scenario) => `  ${scenario.id} - ${scenario.name}`),
  "",
  "The harness is opt-in: pass --opt-in (or set CHAOS_HARNESS_OPT_IN=1).",
  "Scenarios run against in-memory fakes only; --endpoint values are",
  "validated to allow localhost/test services and the public Stellar",
  "testnet only, and are never contacted by the harness."
].join("\n");

export function selectChaosScenarios(scenarioId: string): ChaosScenarioDefinition[] {
  if (scenarioId === "all") {
    return [...chaosScenarios];
  }
  const scenario = getChaosScenario(scenarioId);
  if (scenario === undefined) {
    throw new Error(
      `Unknown chaos scenario: ${scenarioId}. Known scenarios: ${chaosScenarios.map((candidate) => candidate.id).join(", ")}.`
    );
  }
  return [scenario];
}

export async function runChaosCli(options: Partial<ChaosCliOptions> = {}): Promise<ChaosCliResult> {
  const merged: ChaosCliOptions = {
    ...defaultOptions,
    ...options,
    endpoints: { ...(options.endpoints ?? defaultOptions.endpoints) }
  };
  if (!merged.optIn && process.env.CHAOS_HARNESS_OPT_IN !== "1") {
    throw new Error(
      "Chaos harness is opt-in: pass --opt-in (or set CHAOS_HARNESS_OPT_IN=1) to run scenarios."
    );
  }

  // Fails closed on any non-test endpoint before anything runs.
  const injector = new ChaosFaultInjector(merged.endpoints);
  const definitions = selectChaosScenarios(merged.scenarioId);
  const reports: ChaosReport[] = [];
  for (const definition of definitions) {
    const runDefinition =
      merged.seed === undefined ? definition : { ...definition, seed: merged.seed };
    reports.push(await runChaosScenario(runDefinition, new InMemoryChaosSystem(), { injector }));
    injector.reset();
  }

  const outputPaths: string[] = [];
  if (merged.outputPath !== undefined) {
    const outputPath = resolve(merged.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(reports, null, 2)}\n`, "utf8");
    outputPaths.push(outputPath);
  }

  return { passed: reports.every((report) => report.passed), reports, outputPaths };
}

async function main(): Promise<void> {
  let options: ChaosCliOptions;
  try {
    options = parseChaosArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ChaosHelpRequested) {
      console.log(chaosUsage);
      return;
    }
    throw error;
  }

  const result = await runChaosCli(options);
  for (const report of result.reports) {
    const status = report.passed ? "PASS" : "FAIL";
    console.log(
      `${status} ${report.scenarioId} (seed ${String(report.seed)}): ` +
        `${report.recoveryEvidence.jobsCompleted}/${report.recoveryEvidence.jobsSubmitted} jobs completed, ` +
        `${report.recoveryEvidence.settlementsConfirmed} settlement(s) confirmed, ` +
        `${report.recoveryEvidence.ticksToRecover} tick(s) to recover.`
    );
  }
  if (result.outputPaths.length > 0) {
    console.log(`Report written to ${result.outputPaths.join(", ")}`);
  }
  if (!result.passed) {
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;

if (entrypoint === import.meta.url) {
  await main();
}
