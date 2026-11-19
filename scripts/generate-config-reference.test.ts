import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { configKeyMetadata, envSchema } from "../packages/shared/src/config.js";
import {
  additionalRuntimeKeys,
  buildConfigReferenceMarkdown,
  checkConfigReference,
  describeAllConfigKeys,
  describeSchemaKeys,
  introspectZodSchema,
  REDACTED
} from "./generate-config-reference.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvExampleKeys(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.slice(0, line.indexOf("=")).trim())
    .filter((key) => key.length > 0);
}

describe("config reference generator", () => {
  it("documents every key in the authoritative schema", () => {
    const schemaKeys = Object.keys(envSchema.shape).sort();
    const described = describeSchemaKeys();
    const describedKeys = described.map((entry) => entry.key).sort();

    expect(describedKeys).toEqual(schemaKeys);
    expect(described).toHaveLength(schemaKeys.length);
  });

  it("gives every key ownership, sensitivity, and default semantics", () => {
    for (const entry of describeAllConfigKeys()) {
      expect(entry.owner.trim().length, `${entry.key} owner`).toBeGreaterThan(0);
      expect(entry.sensitivity, `${entry.key} sensitivity`).toMatch(/^(secret|non-secret)$/);
      expect(entry.description.trim().length, `${entry.key} description`).toBeGreaterThan(0);
      expect(entry.required, `${entry.key} required`).toMatch(/^(Required|Optional|Conditional)$/);
      expect(
        entry.defaultDisplay === "No default" || entry.defaultDisplay.startsWith("`"),
        `${entry.key} defaultDisplay`
      ).toBe(true);
    }
  });

  it("derives type and default from the schema, not from hand-written values", () => {
    const byKey = new Map(describeSchemaKeys().map((entry) => [entry.key, entry]));

    expect(byKey.get("API_PORT")).toMatchObject({ type: "integer", defaultDisplay: "`3000`" });
    expect(byKey.get("API_HOST")).toMatchObject({ type: "string", defaultDisplay: "`0.0.0.0`" });
    expect(byKey.get("ENABLE_UPTO_SCHEME")).toMatchObject({
      type: "boolean",
      defaultDisplay: "`false`"
    });
    expect(byKey.get("FACILITATOR_SIGNER_PROVIDER")).toMatchObject({
      type: expect.stringContaining("disabled"),
      defaultDisplay: "`disabled`"
    });
    expect(byKey.get("TESTNET_LBT_ISSUER")).toMatchObject({
      defaultDisplay: "No default",
      required: "Optional"
    });
    expect(byKey.get("STELLAR_TESTNET_RPC_URLS")).toMatchObject({
      type: "string",
      defaultDisplay: "No default"
    });
    // NODE_ENV's schema default depends on the process environment at import
    // time, so the reference pins a deterministic display value instead.
    expect(byKey.get("NODE_ENV")?.defaultDisplay).toContain("development");
    expect(byKey.get("NODE_ENV")?.defaultDisplay).toContain("test");
  });

  it("introspects zod wrappers (default, optional, preprocess, coerce)", () => {
    expect(introspectZodSchema(envSchema.shape.API_PORT)).toMatchObject({
      type: "integer",
      hasDefault: true,
      defaultValue: 3000
    });
    expect(introspectZodSchema(envSchema.shape.STELLAR_TESTNET_USDC_CONTRACT_ID)).toMatchObject({
      type: "string",
      hasDefault: false,
      isOptional: true
    });
    expect(introspectZodSchema(envSchema.shape.ENABLE_UPTO_SCHEME)).toMatchObject({
      type: "boolean",
      hasDefault: true,
      defaultValue: false
    });
  });

  it("never prints secret values, even when the environment holds sentinel secrets", () => {
    const sentinels = {
      DATABASE_URL: "postgresql://sentinel-user:SENTINEL_DB_SECRET_9f3a@localhost:5432/sentinel",
      REDIS_URL: "redis://:SENTINEL_REDIS_SECRET_9f3a@localhost:6379",
      EVENT_STREAM_SIGNING_SECRET: "SENTINEL_EVENT_SECRET_9f3a",
      FACILITATOR_SIGNING_KEY: "SENTINEL_SIGNING_KEY_9f3a"
    };
    const previous = { ...process.env };
    Object.assign(process.env, sentinels);

    try {
      const markdown = buildConfigReferenceMarkdown();

      for (const sentinel of Object.values(sentinels)) {
        expect(markdown).not.toContain(sentinel);
      }
      // The schema's own local-development default for DATABASE_URL carries a
      // password and must not appear either.
      expect(markdown).not.toContain("postgres:postgres");

      for (const key of ["DATABASE_URL", "REDIS_URL", "EVENT_STREAM_SIGNING_SECRET"]) {
        const row = markdown.split("\n").find((line) => line.startsWith(`| \`${key}\` `));
        expect(row, `${key} row`).toBeDefined();
        expect(row).toContain(`\`${REDACTED}\``);
        expect(row).toContain("secret");
      }
      const signingKeyRow = markdown
        .split("\n")
        .find((line) => line.startsWith("| `FACILITATOR_SIGNING_KEY` "));
      expect(signingKeyRow).toBeDefined();
      expect(signingKeyRow).toContain(`\`${REDACTED}\``);
      expect(signingKeyRow).toContain("secret");
    } finally {
      process.env = previous;
    }
  });

  it("is deterministic: repeated generation is byte-identical", () => {
    expect(buildConfigReferenceMarkdown()).toBe(buildConfigReferenceMarkdown());
  });

  it("documents runtime keys read outside loadConfig with their source", () => {
    const byKey = new Map(additionalRuntimeKeys.map((entry) => [entry.key, entry]));

    expect(byKey.get("FACILITATOR_SIGNING_KEY")).toMatchObject({
      sensitivity: "secret",
      required: "Conditional",
      defaultDisplay: `\`${REDACTED}\``
    });
    expect(byKey.get("MCP_PORT")).toMatchObject({
      type: "integer",
      defaultDisplay: "`3001`",
      owner: "mcp-server"
    });
    expect(byKey.get("READINESS_PROBE_TIMEOUT_MS")).toMatchObject({
      type: "integer",
      defaultDisplay: "`2000`",
      owner: "api"
    });
    for (const entry of additionalRuntimeKeys) {
      expect(entry.source).toBe("additional");
      expect(entry.description).toContain("process.env");
    }
  });

  it("detects drift: check passes for generated content and fails for stale content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-reference-"));
    const referencePath = join(dir, "configuration-reference.md");
    const { expected } = await checkConfigReference(referencePath);

    await writeFile(referencePath, expected, "utf8");
    expect((await checkConfigReference(referencePath)).inSync).toBe(true);

    await writeFile(referencePath, `${expected}\n<!-- stale edit -->\n`, "utf8");
    const drifted = await checkConfigReference(referencePath);
    expect(drifted.inSync).toBe(false);
    expect(drifted.expected).toBe(expected);
  });

  it("keeps metadata in lockstep with the schema (no missing or stale entries)", () => {
    expect(Object.keys(configKeyMetadata).sort()).toEqual(Object.keys(envSchema.shape).sort());
  });

  it("keeps .env.example covering every schema key", async () => {
    const example = await readFile(join(root, ".env.example"), "utf8");
    const exampleKeys = parseEnvExampleKeys(example);

    for (const key of Object.keys(envSchema.shape)) {
      expect(exampleKeys, `.env.example missing ${key}`).toContain(key);
    }
  });

  it("keeps the checked-in reference in sync with the schema", async () => {
    const { inSync } = await checkConfigReference();
    expect(inSync).toBe(true);
  });
});
