#!/usr/bin/env node

/**
 * Backup integrity verification script.
 *
 * Verifies:
 * - Manifest and encrypted backup file exist
 * - SHA-256 checksum matches
 * - Encryption key is available and correct length
 * - Backup can be decrypted (without restoring)
 *
 * Usage:
 *   BACKUP_ENCRYPTION_KEY="..." pnpm tsx scripts/verify-backup.ts <backup-path> [manifest-path]
 *
 * The manifest-path defaults to <backup-path>.manifest.json if not provided.
 */

import { createReadStream, readFileSync } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
import { resolve, dirname, basename } from "node:path";

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

async function verifyBackup(): Promise<void> {
  const backupPath = process.argv[2];
  if (!backupPath) {
    console.error("Usage: verify-backup.ts <backup-path> [manifest-path]");
    process.exit(1);
  }

  const manifestPath = process.argv[3] || `${backupPath}.manifest.json`;

  console.log("Verifying backup integrity...");
  console.log(`Backup file: ${backupPath}`);
  console.log(`Manifest file: ${manifestPath}`);

  let manifest: BackupManifest;
  try {
    const manifestContent = readFileSync(manifestPath, "utf-8");
    manifest = JSON.parse(manifestContent);
  } catch (error) {
    throw new Error(
      `Failed to read manifest: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Verify checksum
  console.log("\n1. Verifying SHA-256 checksum...");
  try {
    const backupData = readFileSync(backupPath);
    const calculatedChecksum = createHash("sha256").update(backupData).digest("hex");

    if (calculatedChecksum !== manifest.checksum) {
      throw new Error(
        `Checksum mismatch!\n` +
        `  Expected: ${manifest.checksum}\n` +
        `  Got:      ${calculatedChecksum}`
      );
    }
    console.log(`✓ Checksum verified: ${calculatedChecksum}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("mismatch")) {
      throw error;
    }
    throw new Error(
      `Failed to calculate checksum: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Verify encryption key is available
  console.log("\n2. Verifying encryption key...");
  const encryptionKey = getEncryptionKey();
  console.log("✓ Encryption key available and valid");

  // Attempt decryption test
  console.log("\n3. Testing decryption...");
  try {
    const backupData = readFileSync(backupPath);
    const iv = Buffer.from(manifest.iv, "base64");
    const authTag = Buffer.from(manifest.authTag, "base64");

    const decipher = createDecipheriv(
      manifest.encryptionAlgorithm,
      encryptionKey,
      iv
    );
    decipher.setAuthTag(authTag);

    // Try to decrypt first chunk to verify key is correct
    let decryptedSize = 0;
    decipher.on("data", (chunk: Buffer) => {
      decryptedSize += chunk.length;
    });

    decipher.on("error", (error: Error) => {
      throw new Error(`Decryption failed (wrong key?): ${error.message}`);
    });

    decipher.write(backupData);
    decipher.end();

    await new Promise<void>((resolve, reject) => {
      decipher.on("end", () => resolve());
      decipher.on("error", reject);
    });

    console.log(`✓ Decryption successful (${decryptedSize} bytes decrypted)`);
  } catch (error) {
    throw new Error(
      `Decryption test failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Print manifest summary
  console.log("\n4. Backup manifest:");
  console.log(`  Timestamp: ${manifest.timestamp}`);
  console.log(`  Schema: ${manifest.schemaVersion}`);
  console.log(`  Database: ${manifest.databaseUrl}`);
  console.log(`  Algorithm: ${manifest.encryptionAlgorithm}`);
  console.log(`  Record counts:`, manifest.recordCounts);

  console.log("\n✓ Backup verification passed!");
}

async function main() {
  try {
    await verifyBackup();
  } catch (error) {
    console.error(
      `✗ Verification failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

main();
