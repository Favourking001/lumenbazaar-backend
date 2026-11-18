# Encrypted Backup and Restore Procedure

This document describes the durable backup and recovery procedures for LumenBazaar payment evidence, including receipts, settlements, and payment attempts.

## Overview

The backup system provides:

- **Encrypted storage** using AES-256-GCM encryption
- **Integrity verification** via SHA-256 checksums
- **Isolated restore** into disposable test databases only
- **Reconciliation checks** to verify no data loss
- **Automated recovery drills** to measure RTO and validate procedures

## Key Management

### Generating an Encryption Key

Generate a new AES-256 encryption key (base64-encoded):

```bash
pnpm tsx scripts/backup.ts --generate-key
```

Output:
```
Generated new AES-256 encryption key (base64):
<32-byte base64 string>

Store this key securely. Set as BACKUP_ENCRYPTION_KEY environment variable.
```

**Storage Requirements:**
- Store the key in a secure secrets manager (e.g., AWS Secrets Manager, Azure Key Vault, HashiCorp Vault)
- **Never** commit the key to version control
- **Never** share the key via email or chat
- Rotate the key annually or after personnel changes
- Maintain an audit log of key access

### Using the Encryption Key

Set the key as an environment variable before running backup/restore operations:

```bash
export BACKUP_ENCRYPTION_KEY="<your-base64-key>"
```

Or use your secrets manager to inject it at runtime.

## Creating a Backup

### Procedure

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/lumenbazaar"
export BACKUP_ENCRYPTION_KEY="<your-key>"
export BACKUP_OUTPUT_DIR="./backups"

pnpm tsx scripts/backup.ts
```

### Output

Creates two files in `BACKUP_OUTPUT_DIR`:

1. **`backup-<timestamp>.sql.enc`** - Encrypted database dump
2. **`backup-<timestamp>.sql.enc.manifest.json`** - Unencrypted manifest with metadata

Example manifest:
```json
{
  "timestamp": "2024-11-18T14:30:00.000Z",
  "timestampMs": 1234567890000,
  "schemaVersion": "Prisma 6.19.3",
  "databaseUrl": "postgresql://host:5432/lumenbazaar",
  "recordCounts": {
    "Seller": 42,
    "Resource": 156,
    "PaymentAttempt": 5230,
    "Settlement": 5200,
    "Receipt": 5200,
    "PaymentSession": 89,
    "CatalogEvent": 1240
  },
  "checksum": "abc123def456...",
  "encryptionAlgorithm": "aes-256-gcm",
  "iv": "<base64-iv>",
  "authTag": "<base64-auth-tag>"
}
```

### Backup Storage

- **Primary**: Encrypted S3 bucket with versioning enabled
- **Secondary**: Offline encrypted storage (e.g., encrypted USB drive in secure facility)
- **Retention**: Keep backups for 90 days minimum
- **Testing**: Test restore from backups weekly

## Verifying a Backup

### Procedure

```bash
export BACKUP_ENCRYPTION_KEY="<your-key>"

pnpm tsx scripts/verify-backup.ts ./backups/backup-<timestamp>.sql.enc
```

Verification checks:
1. ✓ Manifest file exists and is readable
2. ✓ SHA-256 checksum matches (detects file corruption or tampering)
3. ✓ Encryption key is valid and correct length
4. ✓ Backup can be decrypted (tests key without fully extracting)
5. ✓ Reports record counts and schema version

### Success Output

```
Verifying backup integrity...
Backup file: ./backups/backup-1234567890000.sql.enc
Manifest file: ./backups/backup-1234567890000.sql.enc.manifest.json

1. Verifying SHA-256 checksum...
✓ Checksum verified: abc123def456...

2. Verifying encryption key...
✓ Encryption key available and valid

3. Testing decryption...
✓ Decryption successful (152847 bytes decrypted)

4. Backup manifest:
  Timestamp: 2024-11-18T14:30:00.000Z
  Schema: Prisma 6.19.3
  Database: postgresql://host:5432/lumenbazaar
  Algorithm: aes-256-gcm
  Record counts: { Seller: 42, Resource: 156, ... }

✓ Backup verification passed!
```

### Failure Modes

| Error | Cause | Action |
| --- | --- | --- |
| "Checksum mismatch" | File corrupted or tampered | Restore from another copy; verify storage integrity |
| "BACKUP_ENCRYPTION_KEY not found" | Key not set | Export correct key to environment |
| "Key must be exactly 32 bytes" | Invalid key format | Generate new key or verify base64 encoding |
| "Decryption failed (wrong key?)" | Wrong encryption key used | Verify key matches backup's creation key |

## Restoring from Backup

### Procedure

```bash
export BACKUP_ENCRYPTION_KEY="<your-key>"
export PRIMARY_DATABASE_URL="postgresql://user:pass@host:5432/lumenbazaar"

pnpm tsx scripts/restore-backup.ts ./backups/backup-<timestamp>.sql.enc
```

### Safeguards

The restore script includes production guards:

1. **Refuses production restore** - Will not restore to the primary DATABASE_URL
2. **Creates isolated test database** - Automatically creates a temporary database
3. **Verifies backup before restore** - Runs integrity check first
4. **Applies migrations** - Brings schema to current version
5. **Provides cleanup procedure** - Tells you how to drop test database

### Restore Output

```
Restoring encrypted database backup...
Backup file: ./backups/backup-1234567890000.sql.enc
Manifest file: ./backups/backup-1234567890000.sql.enc.manifest.json

1. Verifying backup integrity...
✓ Backup verification passed!

2. Checking restore target...
✓ Safe to restore (not production database)

3. Creating isolated test database...
✓ Test database created: restore_test_1700316600000_a7f2k

4. Decrypting backup...
✓ Decrypted 152847 bytes

5. Restoring data...
✓ Database restored

6. Applying migrations to restored database...
✓ Migrations applied

✓ Restore completed successfully!

Restored database URL:
postgresql://postgres:postgres@localhost:5432/restore_test_1700316600000_a7f2k

Cleanup with:
pnpm tsx scripts/migrations.mjs cleanup restore_test_1700316600000_a7f2k
```

### Post-Restore Verification

After restore completes, the restored database is ready for reconciliation checks.

**Important:** The restored database is temporary and exists only for verification. Always clean up after testing.

## Reconciliation Checks

After restore, verify that all payment evidence reconciles:

```bash
export PRIMARY_DATABASE_URL="postgresql://user:pass@host:5432/lumenbazaar"

pnpm tsx scripts/reconcile-backup.ts \
  postgresql://postgres:postgres@localhost:5432/restore_test_1700316600000_a7f2k \
  postgresql://user:pass@host:5432/lumenbazaar
```

Reconciliation checks:

1. **Record counts** - Payment, Settlement, Receipt, and Session counts match
2. **Referential integrity** - All foreign keys are valid (no orphaned records)
3. **Idempotency keys** - All PaymentAttempts have idempotency keys (no duplicates)

### Success Output

```
============================================================
RECONCILIATION REPORT
============================================================
Timestamp: 2024-11-18T14:35:00.000Z
Status: ✓ PASS

Record Counts:
  ✓ PaymentAttempt: 5230 → 5230
  ✓ Settlement: 5200 → 5200
  ✓ Receipt: 5200 → 5200
  ✓ PaymentSession: 89 → 89

============================================================
```

### Failure Modes

If reconciliation fails, compare manually:

```bash
# Check source counts
psql $SOURCE_DB -c "SELECT COUNT(*) FROM \"PaymentAttempt\";"

# Check restored counts
psql $RESTORED_DB -c "SELECT COUNT(*) FROM \"PaymentAttempt\";"

# Check for orphaned records
psql $RESTORED_DB -c \
  "SELECT COUNT(*) FROM \"Settlement\" s \
   WHERE NOT EXISTS (SELECT 1 FROM \"PaymentAttempt\" pa WHERE pa.id = s.\"paymentAttemptId\");"
```

## Automated Recovery Drill

Run a complete backup → verify → restore → reconcile cycle to test recovery procedures:

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/lumenbazaar"
export BACKUP_ENCRYPTION_KEY="<your-key>"
export BACKUP_OUTPUT_DIR="./backups"

pnpm tsx scripts/backup-recovery-drill.ts
```

Drill output includes:
- ✓ Pass/fail status for each stage
- Recovery Time Objective (RTO) in milliseconds per stage
- Total drill duration
- Drill ID for tracking

### Scheduled Drills

Add to CI/CD workflow or cron:

```yaml
# .github/workflows/backup-recovery-drill.yml
name: Backup Recovery Drill
on:
  schedule:
    - cron: "0 2 * * 0"  # Weekly at 2 AM Sunday

jobs:
  drill:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: "pnpm"
      - run: pnpm install
      - run: pnpm tsx scripts/backup-recovery-drill.ts
        env:
          DATABASE_URL: ${{ secrets.PRIMARY_DATABASE_URL }}
          BACKUP_ENCRYPTION_KEY: ${{ secrets.BACKUP_ENCRYPTION_KEY }}
          BACKUP_OUTPUT_DIR: ./backups
      - name: Upload drill report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: drill-report
          path: backups/*-report.json
```

### Expected RTO

- **Backup creation**: 2–10 seconds (depending on database size)
- **Verification**: 1–3 seconds
- **Restore & migration**: 5–15 seconds
- **Reconciliation**: 2–5 seconds
- **Total**: ~15–40 seconds

Significantly longer times indicate:
- Large database or slow disk I/O
- Network latency to database server
- Resource contention

## Failure Handling

### Backup Fails

1. Check disk space: `df -h ./backups`
2. Check database connectivity: `psql $DATABASE_URL -c "SELECT 1"`
3. Verify key is set: `echo $BACKUP_ENCRYPTION_KEY`
4. Check pg_dump availability: `which pg_dump`

### Restore Fails

1. Verify source backup: `pnpm tsx scripts/verify-backup.ts <backup-path>`
2. Check encryption key matches backup creation key
3. Verify test database creation: `psql -l | grep restore_test_`
4. Ensure migrations are compatible with restored schema

### Reconciliation Fails

1. Check if restore actually completed: `psql <restored-db> -c "SELECT COUNT(*) FROM \"Seller\";"`
2. Look for missing foreign keys: See "Failure Modes" above
3. Check if source DB changed during reconciliation (run again)
4. Compare detailed counts table-by-table

### Cannot Cleanup Test Database

```bash
# Manually drop test database
psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS restore_test_1700316600000_a7f2k;"

# Or use migration script
pnpm tsx scripts/migrations.mjs cleanup
```

## Security Considerations

1. **Never log credentials** - Backup scripts sanitize connection strings
2. **Encrypt key at rest** - Use a secrets manager, not environment files
3. **Restrict file permissions** - `chmod 600` on backup files
4. **Verify backup integrity** - Run verification step before restore
5. **Test regularly** - Weekly automated drills catch issues early
6. **Audit access** - Log all backup/restore operations
7. **Validate after restore** - Always run reconciliation checks

## Support and Troubleshooting

For issues:

1. Check the specific error message in script output
2. Verify all required environment variables are set
3. Run in `--verbose` mode for more details (if supported)
4. Review the specific failure mode section above
5. Check database logs for PostgreSQL errors

## Appendix: Command Reference

| Task | Command |
| --- | --- |
| Generate key | `pnpm tsx scripts/backup.ts --generate-key` |
| Create backup | `pnpm tsx scripts/backup.ts` |
| Verify backup | `pnpm tsx scripts/verify-backup.ts <path>` |
| Restore backup | `pnpm tsx scripts/restore-backup.ts <path>` |
| Reconcile data | `pnpm tsx scripts/reconcile-backup.ts <db-url>` |
| Run drill | `pnpm tsx scripts/backup-recovery-drill.ts` |
| Cleanup databases | `pnpm tsx scripts/migrations.mjs cleanup` |
