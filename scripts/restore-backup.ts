#!/usr/bin/env node

/**
 * Restore encrypted database backup to an isolated database.
 *
 * Safeguards:
 * - Refuses to restore to production/primary DATABASE_URL
 * - Creates disposable test database automatically
 * - Verifies backup integrity before restore
 * - Applies migrations after restore
 *
 * Usage:
 *   BACKUP_ENCRYPTION_KEY="..." pnpm tsx scripts/restore-backup.ts <backup-path> [manifest-path]
 *
 * Output:
 *   Prints restored database URL on success for use by reconciliation scripts
 */

import { readFileSync, mkdirSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

interface BackupManifest {
  timestamp: string;
  timestampMs: number;
  schemaVersion: string;
  databaseUrl: string;
  recordCounts: Record<string, number>;
  checksum: string;
  encryptionAlgorithm: string;
  iv: string;
  authTag: string;
}

function getEncryptionKey(): Buffer {
  const keyEnv = process.env.BACKUP_ENCRYPTION_KEY;
  if (!keyEnv) {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY environment variable is required"
    );
  }

  try {
    const keyBuffer = Buffer.from(keyEnv, "base64");
    if (keyBuffer.length !== 32) {
      throw new Error(`Key must be exactly 32 bytes, got ${keyBuffer.length}`);
    }
    return keyBuffer;
  } catch (error) {
    throw new Error(
      `Invalid BACKUP_ENCRYPTION_KEY: must be base64-encoded 32-byte key. ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function refuseProductionRestore(primaryDbUrl: string): void {
  // Extract database name from URL
  const primaryMatch = primaryDbUrl.match(/\/([^/?]+)(?:\?|$)/);
  const primaryDbName = primaryMatch?.[1] || "lumenbazaar";

  const prodPatterns = [
    /prod|production|live|main(?:_db)?/i,
    /^[a-z]*_prod/i,
    "lumenbazaar", // Default assumed to be primary
  ];

  for (const pattern of prodPatterns) {
    const matches = 
      typeof pattern === "string" 
        ? primaryDbName.toLowerCase().includes(pattern.toLowerCase())
        : pattern.test(primaryDbName);
    
    if (matches) {
      throw new Error(
        `RESTORE REFUSED: Detected primary/production database "${primaryDbName}". ` +
        `Restore is only allowed to isolated test databases. ` +
        `Set PRIMARY_DATABASE_URL to override if you're certain.`
      );
    }
  }
}

async function createTestDatabase(
  maintenanceUrl: string = "postgresql://postgres:postgres@localhost:5432/postgres"
): Promise<{ dbUrl: string; dbName: string; cleanup: () => Promise<void> }> {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const dbName = `restore_test_${timestamp}_${random}`;

  console.log(`Creating isolated test database: ${dbName}`);

  const parsed = new URL(maintenanceUrl);
  const host = parsed.hostname;
  const port = parsed.port || "5432";
  const user = parsed.username || "postgres";
  const password = parsed.password || "postgres";

  const pgpassEnv = {
    PGPASSWORD: password,
  };

  const createResult = spawnSync(
    "psql",
    [
      "-h", host,
      "-p", port,
      "-U", user,
      "-d", "postgres",
      "-c", `CREATE DATABASE ${dbName};`,
    ],
    {
      env: { ...process.env, ...pgpassEnv },
      encoding: "utf-8",
    }
  );

  if (createResult.status !== 0) {
    throw new Error(
      `Failed to create test database: ${createResult.stderr || "unknown error"}`
    );
  }

  const dbUrl = `postgresql://${user}:${password}@${host}:${port}/${dbName}`;

  const cleanup = async () => {
    // Terminate connections
    const terminateResult = spawnSync(
      "psql",
      [
        "-h", host,
        "-p", port,
        "-U", user,
        "-d", "postgres",
        "-c",
        `SELECT pg_terminate_backend(pg_stat_activity.pid) FROM pg_stat_activity WHERE pg_stat_activity.datname = '${dbName}' AND pid <> pg_backend_pid();`,
      ],
      {
        env: { ...process.env, ...pgpassEnv },
        encoding: "utf-8",
      }
    );

    // Drop database
    const dropResult = spawnSync(
      "psql",
      [
        "-h", host,
        "-p", port,
        "-U", user,
        "-d", "postgres",
        "-c", `DROP DATABASE IF EXISTS ${dbName};`,
      ],
      {
        env: { ...process.env, ...pgpassEnv },
        encoding: "utf-8",
      }
    );

    if (dropResult.status === 0) {
      console.log(`✓ Cleaned up test database: ${dbName}`);
    }
  };

  return { dbUrl, dbName, cleanup };
}

async function decryptBackup(
  backupPath: string,
  manifest: BackupManifest
): Promise<string> {
  console.log("\nDecrypting backup...");

  const encryptionKey = getEncryptionKey();
  const backupData = readFileSync(backupPath);
  const iv = Buffer.from(manifest.iv, "base64");
  const authTag = Buffer.from(manifest.authTag, "base64");

  const decipher = createDecipheriv(
    manifest.encryptionAlgorithm,
    encryptionKey,
    iv
  );
  decipher.setAuthTag(authTag);

  const decryptedChunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    decipher.on("data", (chunk: Buffer) => {
      decryptedChunks.push(chunk);
    });

    decipher.on("end", () => {
      const decrypted = Buffer.concat(decryptedChunks).toString("utf-8");
      console.log(`✓ Decrypted ${decrypted.length} bytes`);
      resolve(decrypted);
    });

    decipher.on("error", (error: Error) => {
      reject(
        new Error(
          `Decryption failed (wrong key?): ${error.message}`
        )
      );
    });

    decipher.write(backupData);
    decipher.end();
  });
}

async function restoreToDatabase(
  decryptedDump: string,
  targetDbUrl: string
): Promise<void> {
  console.log("\nRestoring to database...");

  const parsed = new URL(targetDbUrl);
  const pgpassEnv = {
    PGPASSWORD: parsed.password || "postgres",
  };

  const psqlResult = spawnSync(
    "psql",
    [targetDbUrl, "--no-password"],
    {
      input: decryptedDump,
      env: { ...process.env, ...pgpassEnv },
      encoding: "utf-8",
    }
  );

  if (psqlResult.status !== 0) {
    throw new Error(
      `Restore failed: ${psqlResult.stderr || "unknown error"}`
    );
  }

  console.log("✓ Database restored");
}

async function applyMigrations(restoredDbUrl: string): Promise<void> {
  console.log("\nApplying migrations...");

  const result = spawnSync(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
    {
      env: { ...process.env, DATABASE_URL: restoredDbUrl },
      stdio: "inherit",
    }
  );

  if (result.status !== 0) {
    throw new Error("Migration deployment failed");
  }

  console.log("✓ Migrations applied");
}

async function restoreBackup(): Promise<void> {
  const backupPath = process.argv[2];
  if (!backupPath) {
    console.error("Usage: restore-backup.ts <backup-path> [manifest-path]");
    process.exit(1);
  }

  const manifestPath = process.argv[3] || `${backupPath}.manifest.json`;

  console.log("Restoring encrypted database backup...");
  console.log(`Backup file: ${backupPath}`);
  console.log(`Manifest file: ${manifestPath}`);

  // Load manifest
  let manifest: BackupManifest;
  try {
    const manifestContent = readFileSync(manifestPath, "utf-8");
    manifest = JSON.parse(manifestContent);
  } catch (error) {
    throw new Error(
      `Failed to read manifest: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Verify backup integrity first
  console.log("\n1. Verifying backup integrity...");
  try {
    const verifyResult = spawnSync(
      "pnpm",
      ["tsx", "scripts/verify-backup.ts", backupPath, manifestPath],
      {
        env: { ...process.env },
        stdio: "inherit",
      }
    );

    if (verifyResult.status !== 0) {
      throw new Error("Backup verification failed");
    }
  } catch (error) {
    throw new Error(
      `Verification failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Refuse production restore
  console.log("\n2. Checking restore target...");
  const primaryDbUrl = process.env.PRIMARY_DATABASE_URL || process.env.DATABASE_URL;
  if (!primaryDbUrl) {
    throw new Error(
      "PRIMARY_DATABASE_URL or DATABASE_URL environment variable required for production check"
    );
  }
  refuseProductionRestore(primaryDbUrl);
  console.log("✓ Safe to restore (not production database)");

  // Create test database
  console.log("\n3. Creating isolated test database...");
  const { dbUrl: restoredDbUrl, dbName, cleanup } = await createTestDatabase();
  console.log(`✓ Test database created: ${dbName}`);
  console.log(`  URL: ${restoredDbUrl}`);

  try {
    // Decrypt backup
    console.log("\n4. Decrypting backup...");
    const decryptedDump = await decryptBackup(backupPath, manifest);

    // Restore to test database
    console.log("\n5. Restoring data...");
    await restoreToDatabase(decryptedDump, restoredDbUrl);

    // Apply migrations
    console.log("\n6. Applying migrations to restored database...");
    await applyMigrations(restoredDbUrl);

    console.log("\n✓ Restore completed successfully!");
    console.log(`\nRestored database URL:\n${restoredDbUrl}`);
    console.log(
      `\nCleanup with:\nnode scripts/migrations.mjs cleanup ${dbName}`
    );
  } catch (error) {
    console.error(
      `\n✗ Restore failed: ${error instanceof Error ? error.message : String(error)}`
    );
    await cleanup();
    process.exit(1);
  }
}

async function main() {
  try {
    await restoreBackup();
  } catch (error) {
    console.error(
      `✗ Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

main();
