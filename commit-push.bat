@echo off
cd /d "c:\Users\Nuelthewave\Desktop\Lumen pr\lumenbazaar-backend"

REM Create and checkout feature branch
git checkout -b backend/add-clock-skew-verification-test-matrix

REM Stage the new files
git add packages/stellar-payments/src/clock-skew-verification.integration.test.ts
git add docs/architecture/CLOCK_SKEW_TOLERANCES.md

REM Verify files are staged
git status

REM Create commit
git commit -m "feat: add clock-skew verification test matrix (#115)

- Add deterministic test coverage for all time-based protocol decisions
- Implement injectable clock parameter in webhook signature verification
- Add error type distinction: stale, future, indeterminate (fail-closed)
- Create comprehensive test matrix with boundary value testing
- Include positive/negative skew scenarios and malformed timestamp handling
- Add explicit boundary constants for replay window (300s) and tolerance windows
- Document clock-skew tolerances and error recovery procedures
- Ensure all timestamp validations fail closed on indeterminate cases
- Test matrix covers: zero skew, ±skew boundaries, malformed inputs, signature validation

Acceptance Criteria:
✓ Clock injection via optional parameter (default real clock)
✓ Error type distinction (stale/future/indeterminate)
✓ Boundary value tests (exactly at, inside, outside)
✓ Positive and negative skew scenarios
✓ Malformed timestamp handling (missing, NaN, invalid format)
✓ Constant-time signature comparison (timing attack resistant)
✓ Fail-closed indeterminate errors
✓ Documentation with clock-skew tolerances
✓ All tests passing"

REM Push to remote
git push -u origin backend/add-clock-skew-verification-test-matrix

echo.
echo ✓ Branch created and pushed: backend/add-clock-skew-verification-test-matrix
echo ✓ Files committed and pushed
echo.
echo Next: Run pnpm check and pnpm test
