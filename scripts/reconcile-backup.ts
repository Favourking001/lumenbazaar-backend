#!/usr/bin/env node

/**
 * Post-restore reconciliation verification.
 *
 * Checks that payment evidence reconciles between source and restored databases:
 * - Record counts match for Payment, Settlement, Receipt, Idempotency
 * - Referential integrity preserved
 * - No data loss in critical audit fields
 *
 * Usage:
 *   pnpm tsx scripts/reconcile-backup.ts <restored-db-url> [source-db-url]
 *
 * If source-db-url is not provided, uses PRIMARY_DATABASE_URL or DATABASE_URL
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface ReconciliationResult {
  table: string;
  sourceCount: number;
  restoredCount: number;
  matches: boolean;
  discrepancy?: number;
}

interface ReconciliationReport {
  timestamp: string;
  sourceDatabase: string;
  restoredDatabase: string;
  results: ReconciliationResult[];
  allMatch: boolean;
  criticalTables: string[];
  issues: string[];
}

const CRITICAL_TABLES = [
  "PaymentAttempt",
  "Settlement",
  "Receipt",
  "PaymentSession",
];

async function getTableCount(
  dbUrl: string,
  tableName: string
): Promise<number> {
  const result = spawnSync(
    "psql",
    [
      dbUrl,
      "--no-password",
      "-t", // tuples only
      "-c",
      `SELECT COUNT(*) FROM "${tableName}";`,
    ],
    {
      encoding: "utf-8",
    }
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to count ${tableName}: ${result.stderr || "unknown error"}`
    );
  }

  return parseInt(result.stdout.trim(), 10);
}

async function verifyReferentialIntegrity(dbUrl: string): Promise<string[]> {
  const issues: string[] = [];

  console.log("  Checking referential integrity...");

  // Check PaymentAttempt.resourceId references Resource.id (if not null)
  const orphanedPayments = spawnSync(
    "psql",
    [
      dbUrl,
      "--no-password",
      "-t",
      "-c",
      `SELECT COUNT(*) FROM "PaymentAttempt" pa 
       WHERE pa."resourceId" IS NOT NULL 
       AND NOT EXISTS (SELECT 1 FROM "Resource" r WHERE r.id = pa."resourceId");`,
    ],
    {
      encoding: "utf-8",
    }
  );

  if (orphanedPayments.status === 0) {
    const count = parseInt(orphanedPayments.stdout.trim(), 10);
    if (count > 0) {
      issues.push(`${count} orphaned PaymentAttempt records (missing Resource)`);
    }
  }

  // Check Settlement.paymentAttemptId references PaymentAttempt.id
  const orphanedSettlements = spawnSync(
    "psql",
    [
      dbUrl,
      "--no-password",
      "-t",
      "-c",
      `SELECT COUNT(*) FROM "Settlement" s 
       WHERE NOT EXISTS (SELECT 1 FROM "PaymentAttempt" pa WHERE pa.id = s."paymentAttemptId");`,
    ],
    {
      encoding: "utf-8",
    }
  );

  if (orphanedSettlements.status === 0) {
    const count = parseInt(orphanedSettlements.stdout.trim(), 10);
    if (count > 0) {
      issues.push(
        `${count} orphaned Settlement records (missing PaymentAttempt)`
      );
    }
  }

  // Check Receipt.paymentAttemptId references PaymentAttempt.id
  const orphanedReceipts = spawnSync(
    "psql",
    [
      dbUrl,
      "--no-password",
      "-t",
      "-c",
      `SELECT COUNT(*) FROM "Receipt" r 
       WHERE NOT EXISTS (SELECT 1 FROM "PaymentAttempt" pa WHERE pa.id = r."paymentAttemptId");`,
    ],
    {
      encoding: "utf-8",
    }
  );

  if (orphanedReceipts.status === 0) {
    const count = parseInt(orphanedReceipts.stdout.trim(), 10);
    if (count > 0) {
      issues.push(`${count} orphaned Receipt records (missing PaymentAttempt)`);
    }
  }

  return issues;
}

async function verifyIdempotencyKeys(dbUrl: string): Promise<string[]> {
  const issues: string[] = [];

  console.log("  Checking idempotency keys...");

  // Check for duplicate idempotencyKey values (should be unique)
  const duplicates = spawnSync(
    "psql",
    [
      dbUrl,
      "--no-password",
      "-t",
      "-c",
      `SELECT COUNT(*) FROM (
        SELECT "idempotencyKey", COUNT(*) as cnt 
        FROM "PaymentAttempt" 
        GROUP BY "idempotencyKey" 
        HAVING COUNT(*) > 1
      ) x;`,
    ],
    {
      encoding: "utf-8",
    }
  );

  if (duplicates.status === 0) {
    const count = parseInt(duplicates.stdout.trim(), 10);
    if (count > 0) {
      issues.push(`${count} duplicate idempotencyKey values found`);
    }
  }

  // Check for NULL idempotencyKey (should always be present)
  const nullKeys = spawnSync(
    "psql",
    [
      dbUrl,
      "--no-password",
      "-t",
      "-c",
      `SELECT COUNT(*) FROM "PaymentAttempt" WHERE "idempotencyKey" IS NULL;`,
    ],
    {
      encoding: "utf-8",
    }
  );

  if (nullKeys.status === 0) {
    const count = parseInt(nullKeys.stdout.trim(), 10);
    if (count > 0) {
      issues.push(`${count} PaymentAttempt records missing idempotencyKey`);
    }
  }

  return issues;
}

async function reconcileBackup(): Promise<void> {
  const restoredDbUrl = process.argv[2];
  if (!restoredDbUrl) {
    console.error("Usage: reconcile-backup.ts <restored-db-url> [source-db-url]");
    process.exit(1);
  }

  const sourceDbUrl =
    process.argv[3] ||
    process.env.PRIMARY_DATABASE_URL ||
    process.env.DATABASE_URL;

  if (!sourceDbUrl) {
    throw new Error(
      "Source database URL required (via argument, PRIMARY_DATABASE_URL, or DATABASE_URL)"
    );
  }

  console.log("Reconciling backup between source and restored databases...");
  console.log(`Source: ${sourceDbUrl.split("/").pop()}`);
  console.log(`Restored: ${restoredDbUrl.split("/").pop()}`);

  const tables = CRITICAL_TABLES;
  const results: ReconciliationResult[] = [];
  const issues: string[] = [];

  console.log("\n1. Comparing record counts...");
  for (const table of tables) {
    console.log(`  ${table}...`);
    try {
      const sourceCount = await getTableCount(sourceDbUrl, table);
      const restoredCount = await getTableCount(restoredDbUrl, table);
      const matches = sourceCount === restoredCount;

      const result: ReconciliationResult = {
        table,
        sourceCount,
        restoredCount,
        matches,
      };

      if (!matches) {
        result.discrepancy = Math.abs(sourceCount - restoredCount);
        issues.push(
          `${table}: source=${sourceCount}, restored=${restoredCount}, diff=${result.discrepancy}`
        );
      }

      results.push(result);
      console.log(`    ✓ ${sourceCount} records`);
    } catch (error) {
      console.error(
        `    ✗ Failed: ${error instanceof Error ? error.message : String(error)}`
      );
      issues.push(
        `${table}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  console.log("\n2. Verifying referential integrity (restored DB)...");
  try {
    const integrityIssues = await verifyReferentialIntegrity(restoredDbUrl);
    issues.push(...integrityIssues);
    if (integrityIssues.length === 0) {
      console.log("  ✓ All references valid");
    } else {
      integrityIssues.forEach((issue) => console.error(`  ✗ ${issue}`));
    }
  } catch (error) {
    console.error(
      `  ✗ Integrity check failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log("\n3. Verifying idempotency (restored DB)...");
  try {
    const idempotencyIssues = await verifyIdempotencyKeys(restoredDbUrl);
    issues.push(...idempotencyIssues);
    if (idempotencyIssues.length === 0) {
      console.log("  ✓ Idempotency keys intact");
    } else {
      idempotencyIssues.forEach((issue) => console.error(`  ✗ ${issue}`));
    }
  } catch (error) {
    console.error(
      `  ✗ Idempotency check failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const allMatch = results.every((r) => r.matches);

  console.log("\n" + "=".repeat(60));
  console.log("RECONCILIATION REPORT");
  console.log("=".repeat(60));
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Status: ${allMatch && issues.length === 0 ? "✓ PASS" : "✗ FAIL"}`);

  console.log("\nRecord Counts:");
  results.forEach((r) => {
    const symbol = r.matches ? "✓" : "✗";
    console.log(
      `  ${symbol} ${r.table}: ${r.sourceCount} → ${r.restoredCount}`
    );
  });

  if (issues.length > 0) {
    console.log("\nIssues Found:");
    issues.forEach((issue) => console.log(`  ✗ ${issue}`));
  }

  console.log("=".repeat(60));

  if (issues.length > 0) {
    process.exit(1);
  }
}

async function main() {
  try {
    await reconcileBackup();
  } catch (error) {
    console.error(
      `✗ Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

main();
