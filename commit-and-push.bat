@echo off
setlocal enabledelayedexpansion

cd /d "c:\Users\Nuelthewave\Desktop\Lumen pr\lumenbazaar-backend"

echo.
echo ============================================================
echo GitHub Issue #54: Encrypted Backup and Restore Verification
echo ============================================================
echo.

set BRANCH=feature/issue-54-encrypted-backup-restore

echo Creating branch: %BRANCH%
git checkout -b %BRANCH% 2>nul || git checkout %BRANCH%
if errorlevel 1 (
    echo Error: Could not create or checkout branch
    exit /b 1
)

echo.
echo Adding new files...
git add scripts\backup.ts
git add scripts\verify-backup.ts
git add scripts\restore-backup.ts
git add scripts\reconcile-backup.ts
git add scripts\backup-recovery-drill.ts
git add scripts\backup-restore.integration.test.ts
git add docs\operations\BACKUP_AND_RESTORE.md
git add package.json

echo.
echo Files added. Checking status...
git status --short

echo.
echo Creating commit...
git commit -m "feat: add encrypted backup and restore verification system (#54)"

if errorlevel 1 (
    echo Error: Commit failed
    exit /b 1
)

echo.
echo Pushing to remote...
git push -u origin %BRANCH%

if errorlevel 1 (
    echo Error: Push failed
    exit /b 1
)

echo.
echo ============================================================
echo SUCCESS: Branch pushed to origin/%BRANCH%
echo ============================================================
echo.
echo Next steps:
echo  1. Create a pull request from origin/%BRANCH% to main
echo  2. Run: pnpm check
echo  3. Verify tests pass
echo.
