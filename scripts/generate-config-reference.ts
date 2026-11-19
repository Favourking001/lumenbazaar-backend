import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

import {
  configKeyMetadata,
  envSchema,
  type ConfigKeyMetadata,
  type ConfigKeySection
} from "../packages/shared/src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const configReferencePath = resolve(root, "docs/deployment/configuration-reference.md");

export const REDACTED = "<redacted>";

/**
 * A single runtime configuration key as documented in the reference.
 * `source` distinguishes keys validated by the zod schema in `loadConfig`
 * from keys read directly from `process.env` elsewhere in the services.
 */
export type DescribedConfigKey = {
  key: string;
  type: string;
  required: "Required" | "Optional" | "Conditional";
  /** Markdown to render in the Default column (already code-formatted). */
  defaultDisplay: string;
  sensitivity: "secret" | "non-secret";
  owner: string;
  section: ConfigKeySection | "additional";
  description: string;
  source: "envSchema" | "additional";
};

type ZodDefLike = {
  type?: string;
  defaultValue?: unknown;
  innerType?: ZodSchemaLike;
  out?: ZodSchemaLike;
  entries?: Record<string, string>;
  checks?: Array<{ _zod?: { def?: { format?: string; check?: string } } }>;
};

type ZodSchemaLike = {
  _zod?: { def?: ZodDefLike };
  options?: string[];
};

type Introspection = {
  type: string;
  hasDefault: boolean;
  defaultValue: unknown;
  isOptional: boolean;
};

/**
 * Derive type, required/optional, and default semantics from a zod schema
 * by unwrapping `default` / `optional` / `pipe` (preprocess, coerce)
 * wrappers until the base schema is reached.
 */
export function introspectZodSchema(schema: unknown): Introspection {
  const def = (schema as ZodSchemaLike | undefined)?._zod?.def;
  const type = def?.type;

  if (def === undefined) {
    return { type: "unknown", hasDefault: false, defaultValue: undefined, isOptional: false };
  }

  if (type === "default") {
    const inner = introspectZodSchema(def.innerType);
    return { ...inner, hasDefault: true, defaultValue: def.defaultValue };
  }

  if (type === "optional") {
    const inner = introspectZodSchema(def.innerType);
    return { ...inner, isOptional: true };
  }

  if (type === "pipe") {
    // z.preprocess / z.coerce wrap the real schema in `out`.
    return introspectZodSchema(def.out);
  }

  if (type === "enum") {
    const values = Object.keys(def.entries ?? {});
    const fromOptions = (schema as ZodSchemaLike | undefined)?.options ?? values;
    return {
      type: `enum (${fromOptions.map((value) => `\`${value}\``).join(" \\| ")})`,
      hasDefault: false,
      defaultValue: undefined,
      isOptional: false
    };
  }

  if (type === "string") {
    const isUrl = (def.checks ?? []).some((check) => check._zod?.def?.format === "url");
    return {
      type: isUrl ? "string (URL)" : "string",
      hasDefault: false,
      defaultValue: undefined,
      isOptional: false
    };
  }

  if (type === "number") {
    const isInteger = (def.checks ?? []).some((check) =>
      ["int", "safeint"].includes(check._zod?.def?.format ?? "")
    );
    return {
      type: isInteger ? "integer" : "number",
      hasDefault: false,
      defaultValue: undefined,
      isOptional: false
    };
  }

  if (type === "boolean") {
    return { type: "boolean", hasDefault: false, defaultValue: undefined, isOptional: false };
  }

  return {
    type: type ?? "unknown",
    hasDefault: false,
    defaultValue: undefined,
    isOptional: false
  };
}

function renderDefaultValue(value: unknown): string {
  if (typeof value === "string") {
    return `\`${value}\``;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return `\`${String(value)}\``;
  }

  return "No default";
}

function describeSchemaKey(key: string, metadata: ConfigKeyMetadata): DescribedConfigKey {
  const schema = (envSchema.shape as Record<string, unknown>)[key];
  const intro = introspectZodSchema(schema);
  const defaultValue =
    typeof intro.defaultValue === "function"
      ? (intro.defaultValue as () => unknown)()
      : intro.defaultValue;

  return {
    key,
    type: intro.type,
    required: !intro.hasDefault && !intro.isOptional ? "Required" : "Optional",
    defaultDisplay:
      metadata.sensitivity === "secret"
        ? `\`${REDACTED}\``
        : (metadata.defaultDisplay ??
          (intro.hasDefault ? renderDefaultValue(defaultValue) : "No default")),
    sensitivity: metadata.sensitivity,
    owner: metadata.owner,
    section: metadata.section,
    description:
      metadata.notes === undefined
        ? metadata.description
        : `${metadata.description} ${metadata.notes}`,
    source: "envSchema"
  };
}

/**
 * Every key in the authoritative schema, described from the schema itself
 * merged with its metadata entry. Throws when a schema key has no metadata
 * entry or a metadata entry has no schema key, so schema and documentation
 * metadata cannot drift apart silently.
 */
export function describeSchemaKeys(): DescribedConfigKey[] {
  const schemaKeys = Object.keys(envSchema.shape);
  const metadataKeys = Object.keys(configKeyMetadata);

  const missingMetadata = schemaKeys.filter((key) => !(key in configKeyMetadata));
  if (missingMetadata.length > 0) {
    throw new Error(
      `configKeyMetadata is missing entries for schema keys: ${missingMetadata.join(", ")}. ` +
        "Add a metadata entry in packages/shared/src/config.ts."
    );
  }

  const staleMetadata = metadataKeys.filter((key) => !schemaKeys.includes(key));
  if (staleMetadata.length > 0) {
    throw new Error(
      `configKeyMetadata has entries with no schema key: ${staleMetadata.join(", ")}. ` +
        "Remove the stale entry from packages/shared/src/config.ts."
    );
  }

  return schemaKeys
    .map((key) => describeSchemaKey(key, configKeyMetadata[key as keyof typeof configKeyMetadata]))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Runtime keys read directly from `process.env` outside `loadConfig`, so
 * they are not validated by the zod schema. They are documented here
 * explicitly — with the file that reads them — so that every runtime key
 * still has ownership and default semantics. `required` is `Conditional`
 * for keys that are only needed for a particular signer mode.
 */
export const additionalRuntimeKeys: DescribedConfigKey[] = [
  {
    key: "API_BASE_URL",
    type: "string (URL)",
    required: "Optional",
    defaultDisplay: "`http://localhost:3000`",
    sensitivity: "non-secret",
    owner: "mcp-server",
    section: "additional",
    description:
      "Base URL of the API used by the MCP server's backend client and by catalog scripts. Read directly from process.env in apps/mcp-server/src/client.ts.",
    source: "additional"
  },
  {
    key: "FACILITATOR_SIGNING_KEY",
    type: "string",
    required: "Conditional",
    defaultDisplay: `\`${REDACTED}\``,
    sensitivity: "secret",
    owner: "stellar-payments",
    section: "additional",
    description:
      "Secret signing key for the environment facilitator signer. Never commit a value; supply it via the hosting provider's secret manager. Read directly from process.env in packages/stellar-payments/src/facilitatorSigner.ts. Required when FACILITATOR_SIGNER_PROVIDER=environment in hosted environments.",
    source: "additional"
  },
  {
    key: "MCP_ALLOWED_ORIGINS",
    type: "string",
    required: "Optional",
    defaultDisplay: "No default",
    sensitivity: "non-secret",
    owner: "mcp-server",
    section: "additional",
    description:
      "Comma-separated list of origins allowed by MCP CORS. Absent or empty means no origin is reflected (the secure default); `*` allows every origin without credentials. Read directly from process.env in apps/mcp-server/src/http.ts.",
    source: "additional"
  },
  {
    key: "MCP_HOST",
    type: "string",
    required: "Optional",
    defaultDisplay: "`API_HOST` (`0.0.0.0`)",
    sensitivity: "non-secret",
    owner: "mcp-server",
    section: "additional",
    description:
      "Host interface the MCP Streamable HTTP server binds to. Falls back to API_HOST. Read directly from process.env in apps/mcp-server/src/http.ts.",
    source: "additional"
  },
  {
    key: "MCP_PATH",
    type: "string",
    required: "Optional",
    defaultDisplay: "`/mcp`",
    sensitivity: "non-secret",
    owner: "mcp-server",
    section: "additional",
    description:
      "HTTP path the MCP Streamable HTTP server serves on. Read directly from process.env in apps/mcp-server/src/http.ts.",
    source: "additional"
  },
  {
    key: "MCP_PORT",
    type: "integer",
    required: "Optional",
    defaultDisplay: "`3001`",
    sensitivity: "non-secret",
    owner: "mcp-server",
    section: "additional",
    description:
      "Port the MCP Streamable HTTP server listens on. Read directly from process.env in apps/mcp-server/src/http.ts.",
    source: "additional"
  },
  {
    key: "MCP_TRUST_PROXY",
    type: "boolean",
    required: "Optional",
    defaultDisplay: "`false`",
    sensitivity: "non-secret",
    owner: "mcp-server",
    section: "additional",
    description:
      "Trust X-Forwarded-For headers for MCP rate limiting. Set to `true` only behind an ingress that replaces client forwarding headers. Read directly from process.env in apps/mcp-server/src/http.ts.",
    source: "additional"
  },
  {
    key: "READINESS_PROBE_TIMEOUT_MS",
    type: "integer",
    required: "Optional",
    defaultDisplay: "`2000`",
    sensitivity: "non-secret",
    owner: "api",
    section: "additional",
    description:
      "Deadline in milliseconds for readiness probes. Read directly from process.env in apps/api/src/services/readiness.ts.",
    source: "additional"
  }
];

export function describeAllConfigKeys(): DescribedConfigKey[] {
  return [...describeSchemaKeys(), ...additionalRuntimeKeys].sort((a, b) =>
    a.key.localeCompare(b.key)
  );
}

const sectionOrder: Array<{ section: ConfigKeySection | "additional"; title: string }> = [
  { section: "runtime", title: "Runtime" },
  { section: "api", title: "API service" },
  { section: "data", title: "Data stores" },
  { section: "features", title: "Features and assets" },
  { section: "stellar-testnet", title: "Stellar testnet" },
  { section: "stellar-pubnet", title: "Stellar pubnet (mainnet)" },
  { section: "facilitator", title: "Facilitator and signing" },
  { section: "settlement", title: "Settlement fees" },
  { section: "events", title: "Event streams" },
  { section: "additional", title: "Additional runtime keys (not validated by loadConfig)" }
];

function renderTable(keys: DescribedConfigKey[]): string {
  const header =
    "| Key | Type | Required | Default | Sensitivity | Owner | Description |\n" +
    "| --- | --- | --- | --- | --- | --- | --- |";
  const rows = keys.map(
    (entry) =>
      `| \`${entry.key}\` | ${entry.type} | ${entry.required} | ${entry.defaultDisplay} | ${entry.sensitivity} | ${entry.owner} | ${entry.description} |`
  );
  return [header, ...rows].join("\n");
}

/**
 * Build the reference document from the authoritative schema. Pure and
 * deterministic: keys are sorted, there are no timestamps, and no value is
 * ever read from the process environment — secret defaults are rendered as
 * `<redacted>` and no live secret can leak into the output.
 */
export function buildConfigReferenceMarkdown(): string {
  const keys = describeAllConfigKeys();
  const sections = sectionOrder
    .map(({ section, title }) => {
      const sectionKeys = keys
        .filter((entry) => entry.section === section)
        .sort((a, b) => a.key.localeCompare(b.key));
      if (sectionKeys.length === 0) {
        return undefined;
      }
      return `## ${title}\n\n${renderTable(sectionKeys)}`;
    })
    .filter((section) => section !== undefined);

  return `# Configuration Reference

> Generated from the authoritative runtime schema — do not edit by hand.
> Regenerate with \`pnpm config:reference\`. CI fails when this file drifts
> from the schema (\`pnpm config:reference:check\`).
>
> Source of truth: \`packages/shared/src/config.ts\` (\`envSchema\` plus
> \`configKeyMetadata\`). Type, required/optional, and default semantics are
> introspected from the zod schema; ownership, sensitivity, and descriptions
> come from the metadata table. The "Additional runtime keys" section lists
> keys read directly from \`process.env\` outside \`loadConfig\`; those keys
> are not validated by the schema.
>
> Secret values are never printed: keys marked \`secret\` show \`<redacted>\`
> instead of any value or default. This document contains no secret values.
> Supply secrets through the hosting provider's secret manager, never by
> committing them.

${sections.join("\n\n")}

## Out of scope

- OpenTelemetry SDK variables (\`OTEL_SDK_DISABLED\`, \`OTEL_TRACES_SAMPLER\`,
  \`OTEL_TRACES_SAMPLER_ARG\`, \`OTEL_EXPORTER_OTLP_ENDPOINT\`,
  \`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT\`, \`OTEL_SERVICE_NAME\`) are read by
  the tracing setup in \`packages/shared/src/tracing.ts\` but are owned and
  documented by the OpenTelemetry SDK, not by this repository's config.
- Test-only variables (for example \`PAYMENT_PERSISTENCE_TEST_DATABASE_URL\`,
  \`WORKER_TEST_REDIS_URL\`, \`CLIENT_PRIVATE_KEY\`) are used by scripts and
  tests, not by the services at runtime.
- CI variables (for example \`GITHUB_SHA\`, \`RELEASE_COMMIT\`) are set by the
  CI environment, not by deployments.

## Adding a configuration key

1. Add the key to \`envSchema\` in \`packages/shared/src/config.ts\`.
2. Add a matching entry to \`configKeyMetadata\` in the same file (owner,
   sensitivity, section, description). The generator fails if a schema key
   has no metadata entry.
3. Add the key to \`.env.example\` when operators need to set it.
4. Regenerate this reference with \`pnpm config:reference\` and commit the
   result. If the key is read directly from \`process.env\` instead of the
   schema, add it to \`additionalRuntimeKeys\` in
   \`scripts/generate-config-reference.ts\` with the file that reads it.
`;
}

export async function renderConfigReference(): Promise<string> {
  const raw = buildConfigReferenceMarkdown();
  const prettierOptions = (await resolveConfig(configReferencePath)) ?? {};
  return format(raw, { ...prettierOptions, parser: "markdown" });
}

export async function checkConfigReference(referencePath: string = configReferencePath): Promise<{
  inSync: boolean;
  expected: string;
  actual: string;
}> {
  const expected = await renderConfigReference();
  const actual = await readFile(referencePath, "utf8").catch(() => "");
  return { inSync: expected === actual, expected, actual };
}

export function parseGenerateConfigReferenceArgs(argv: string[]): { checkOnly: boolean } {
  for (const arg of argv) {
    if (arg === "--check") {
      return { checkOnly: true };
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown config reference option: ${arg}`);
  }

  return { checkOnly: false };
}

function printUsage() {
  console.log(`Usage: pnpm config:reference [options]

Generates docs/deployment/configuration-reference.md from the authoritative
config schema in packages/shared/src/config.ts.

Options:
  --check    Fail with exit code 1 when the checked-in reference differs
             from what the schema generates (used by CI).
`);
}

async function main() {
  const { checkOnly } = parseGenerateConfigReferenceArgs(process.argv.slice(2));

  if (checkOnly) {
    const { inSync } = await checkConfigReference();
    if (!inSync) {
      console.error(
        "docs/deployment/configuration-reference.md is out of sync with the config schema. Run pnpm config:reference."
      );
      process.exitCode = 1;
      return;
    }
    console.log("Configuration reference is in sync with the config schema.");
    return;
  }

  const content = await renderConfigReference();
  await mkdir(dirname(configReferencePath), { recursive: true });
  await writeFile(configReferencePath, content, "utf8");
  console.log(`wrote docs/deployment/configuration-reference.md`);
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);

if (entrypoint === fileURLToPath(import.meta.url)) {
  await main();
}
