/**
 * Generate public error catalog from typed errors and error metadata.
 * Outputs machine-readable JSON and human-readable markdown documentation.
 * Deterministic and idempotent: stable ordering, no timestamps in generated files.
 *
 * Usage:
 *   tsx scripts/generate-error-catalog.ts
 *   tsx scripts/generate-error-catalog.ts --check (fail if catalog is stale)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  errorCatalog,
  catalogMetadata,
  validateErrorCatalog,
  getPublicErrorCatalog
} from "../packages/shared/src/errorCatalog.js";
import { errorCodes } from "../packages/shared/src/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const docsDir = path.join(rootDir, "docs", "api");
const catalogJsonPath = path.join(docsDir, "error-catalog.json");
const catalogMdPath = path.join(docsDir, "error-catalog.md");

// Ensure docs/api directory exists
if (!fs.existsSync(docsDir)) {
  fs.mkdirSync(docsDir, { recursive: true });
}

// Validate catalog before generating
const validationErrors = validateErrorCatalog();
if (validationErrors.length > 0) {
  console.error("❌ Error catalog validation failed:");
  for (const error of validationErrors) {
    console.error(`   - ${error}`);
  }
  process.exit(1);
}

// Check for codes in errors.ts that are not in catalog
const codesNotInCatalog = errorCodes.filter(
  (code) => !(code in errorCatalog)
);
if (codesNotInCatalog.length > 0) {
  console.error("❌ Error codes in errors.ts but missing from catalog:");
  for (const code of codesNotInCatalog) {
    console.error(`   - ${code}`);
  }
  console.error("\n💡 Fix: Add entries to packages/shared/src/errorCatalog.ts");
  process.exit(1);
}

// Check for catalog entries that are not in errors.ts
const catalogCodesNotInErrors = Object.keys(errorCatalog).filter(
  (code) => !errorCodes.includes(code as any)
);
if (catalogCodesNotInErrors.length > 0) {
  console.error("❌ Error codes in catalog but missing from errors.ts:");
  for (const code of catalogCodesNotInErrors) {
    console.error(`   - ${code}`);
  }
  console.error("\n💡 Fix: Remove entries from packages/shared/src/errorCatalog.ts");
  process.exit(1);
}

// Generate machine-readable JSON catalog (deterministic ordering)
function generateJsonCatalog() {
  const entries: Record<string, any> = {};

  // Sort codes alphabetically for deterministic output
  for (const code of [...errorCodes].sort()) {
    const entry = errorCatalog[code];
    if (!entry.isPublic) {
      continue; // Skip internal-only errors
    }

    entries[code] = {
      code: entry.code,
      httpStatus: entry.httpStatus,
      category: entry.category,
      retryable: entry.retryable,
      retryGuidance: entry.retryGuidance,
      ...(entry.maxRetries !== undefined && { maxRetries: entry.maxRetries }),
      ...(entry.reconciliation && { reconciliation: entry.reconciliation }),
      safeUserMessage: entry.safeUserMessage,
      documentation: entry.documentation,
      isPublic: entry.isPublic
    };
  }

  return {
    version: catalogMetadata.version,
    catalog: entries
  };
}

// Generate human-readable markdown documentation
function generateMarkdownCatalog() {
  const publicCatalog = getPublicErrorCatalog();
  const codes = [...Object.keys(publicCatalog)].sort();

  const lines: string[] = [];

  lines.push("# Error Catalog\n");
  lines.push(
    "Structured error definitions for SDK and API consumers. "
  );
  lines.push("This is the single source of truth for error codes, retryability, recovery guidance, and safe user messages.\n");

  lines.push("## Catalog Info\n");
  lines.push(`- **Version**: ${catalogMetadata.version}`);
  lines.push(`- **Total Errors**: ${codes.length}`);
  lines.push(`- **All Public**: Yes\n`);

  lines.push("## Error Categories\n");
  const categories = new Set(Object.values(publicCatalog).map((e) => e.category));
  for (const category of [...categories].sort()) {
    lines.push(`- **${category}**`);
  }
  lines.push("");

  lines.push("## Retry Strategy\n");
  lines.push("| Guidance | Meaning |");
  lines.push("|----------|---------|");
  lines.push("| `safe_to_retry` | Safe to retry immediately or with brief delay |");
  lines.push("| `backoff_required` | Use exponential backoff (e.g., 1s, 2s, 4s, 8s) |");
  lines.push("| `never_retry` | Terminal state; do not retry |");
  lines.push("");

  lines.push("## Error Codes\n");

  for (const code of codes) {
    const entry = publicCatalog[code];

    lines.push(`### ${code}`);
    lines.push("");
    lines.push(`**HTTP Status**: \`${entry.httpStatus}\`\n`);
    lines.push(`**Category**: \`${entry.category}\`\n`);
    lines.push(`**Retryable**: ${entry.retryable ? "Yes" : "No"}`);
    if (entry.retryable) {
      lines.push(
        ` — ${entry.retryGuidance}${entry.maxRetries ? ` (max ${entry.maxRetries} retries)` : ""}`
      );
    }
    lines.push("\n");

    lines.push(`**Safe User Message**:\n`);
    lines.push(`> ${entry.safeUserMessage}\n`);

    lines.push("**Description**:\n");
    lines.push(`${entry.documentation}\n`);

    if (entry.reconciliation) {
      lines.push("**Recovery Guidance**:\n");
      lines.push(`${entry.reconciliation}\n`);
    }

    lines.push("---\n");
  }

  lines.push("## Adding New Errors\n");
  lines.push("1. Add the error code to `packages/shared/src/errors.ts`");
  lines.push("2. Add an entry to `packages/shared/src/errorCatalog.ts` with all required fields:");
  lines.push("   - `code`: Stable, never changes");
  lines.push("   - `httpStatus`: Appropriate HTTP status code");
  lines.push("   - `category`: One of: validation, authentication, resource, payment, infrastructure");
  lines.push("   - `retryable`: Boolean reflecting whether the operation can be safely retried");
  lines.push("   - `retryGuidance`: safe_to_retry, backoff_required, or never_retry");
  lines.push("   - `safeUserMessage`: Must not leak secrets, internal details, or identifiers");
  lines.push("   - `documentation`: Developer-facing detailed explanation");
  lines.push("   - `reconciliation` (payment errors only): How to recover or verify state");
  lines.push("3. Run `pnpm check` to regenerate and validate the catalog");
  lines.push("4. Commit the updated catalog and documentation\n");

  lines.push("## CI Guard\n");
  lines.push("The `pnpm check` command includes validation that:");
  lines.push("- All error codes are documented");
  lines.push("- No error codes are missing required fields");
  lines.push("- All codes are unique");
  lines.push("- No undocumented additions are committed\n");

  return lines.join("\n");
}

// Main generation logic
function main() {
  const checkMode = process.argv.includes("--check");

  const jsonCatalog = generateJsonCatalog();
  const jsonContent = JSON.stringify(jsonCatalog, null, 2) + "\n";

  const markdownCatalog = generateMarkdownCatalog();

  if (checkMode) {
    // Check if files exist and match
    let needsUpdate = false;

    if (!fs.existsSync(catalogJsonPath)) {
      console.log(`📝 ${catalogJsonPath} does not exist`);
      needsUpdate = true;
    } else {
      const existing = fs.readFileSync(catalogJsonPath, "utf-8");
      if (existing !== jsonContent) {
        console.log(`📝 ${catalogJsonPath} is out of date`);
        needsUpdate = true;
      }
    }

    if (!fs.existsSync(catalogMdPath)) {
      console.log(`📝 ${catalogMdPath} does not exist`);
      needsUpdate = true;
    } else {
      const existing = fs.readFileSync(catalogMdPath, "utf-8");
      if (existing !== markdownCatalog) {
        console.log(`📝 ${catalogMdPath} is out of date`);
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      console.error(
        "\n❌ Error catalog is stale. Run `pnpm openapi:generate` to regenerate.\n"
      );
      process.exit(1);
    }

    console.log("✅ Error catalog is up to date");
  } else {
    // Generate files
    fs.writeFileSync(catalogJsonPath, jsonContent);
    console.log(`✅ Generated ${catalogJsonPath}`);

    fs.writeFileSync(catalogMdPath, markdownCatalog);
    console.log(`✅ Generated ${catalogMdPath}`);
  }
}

main();
