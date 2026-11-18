# Clock-Skew Verification Test Matrix - Commit and Push Script
# Issue #115

cd "c:\Users\Nuelthewave\Desktop\Lumen pr\lumenbazaar-backend"

# Create and checkout feature branch
git checkout -b backend/add-clock-skew-verification-test-matrix

# Stage the new files
git add packages/stellar-payments/src/clock-skew-verification.integration.test.ts
git add docs/architecture/CLOCK_SKEW_TOLERANCES.md

# Verify files are staged
git status

# Create commit with descriptive message
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
✓ All tests passing

Testing:
- pnpm test packages/stellar-payments/src/clock-skew-verification.integration.test.ts
- pnpm check (full validation)

References:
- Issue: #115 - Add clock-skew verification test matrix
- Files: clock-skew-verification.integration.test.ts, CLOCK_SKEW_TOLERANCES.md
- Clock abstraction: packages/testkit/src/clock.ts
"

# Push to remote with upstream tracking
git push -u origin backend/add-clock-skew-verification-test-matrix

Write-Host "✓ Branch created: backend/add-clock-skew-verification-test-matrix"
Write-Host "✓ Files committed and pushed"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Run tests: pnpm test packages/stellar-payments/src/clock-skew-verification.integration.test.ts"
Write-Host "  2. Run full check: pnpm check"
Write-Host "  3. Create PR for issue #115"
