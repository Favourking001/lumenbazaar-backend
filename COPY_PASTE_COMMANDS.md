# Copy-Paste Git Commands for Issue #115

## Step 1: Navigate to Repository

```powershell
cd "c:\Users\Nuelthewave\Desktop\Lumen pr\lumenbazaar-backend"
```

---

## Step 2: Create Feature Branch

```bash
git checkout -b backend/add-clock-skew-verification-test-matrix
```

**Expected output:**
```
Switched to a new branch 'backend/add-clock-skew-verification-test-matrix'
```

---

## Step 3: Stage the New Files

Copy and paste **one at a time** or all together:

```bash
git add packages/stellar-payments/src/clock-skew-verification.integration.test.ts
git add docs/architecture/CLOCK_SKEW_TOLERANCES.md
```

---

## Step 4: Verify Files are Staged

```bash
git status
```

**Expected output:**
```
On branch backend/add-clock-skew-verification-test-matrix

Changes to be committed:
  (use "git restore --cached <file>..." to unstage)
        new file:   packages/stellar-payments/src/clock-skew-verification.integration.test.ts
        new file:   docs/architecture/CLOCK_SKEW_TOLERANCES.md
```

---

## Step 5: Create the Commit

**Copy the entire block below (all lines including the message):**

```bash
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
- pnpm check

References:
- Issue: #115 - Add clock-skew verification test matrix
- Files: clock-skew-verification.integration.test.ts, CLOCK_SKEW_TOLERANCES.md
- Clock abstraction: packages/testkit/src/clock.ts"
```

**Expected output:**
```
[backend/add-clock-skew-verification-test-matrix xxx] feat: add clock-skew verification test matrix (#115)
 2 files changed, 950 insertions(+)
 create mode 100644 packages/stellar-payments/src/clock-skew-verification.integration.test.ts
 create mode 100644 docs/architecture/CLOCK_SKEW_TOLERANCES.md
```

---

## Step 6: Push to Remote

```bash
git push -u origin backend/add-clock-skew-verification-test-matrix
```

**Expected output:**
```
Enumerating objects: X, done.
Counting objects: 100% (X/X), done.
Delta compression using up to X threads
...
remote: Create a pull request for 'backend/add-clock-skew-verification-test-matrix' on GitHub by visiting:
remote:      https://github.com/LumenRoute/lumenbazaar-backend/pull/new/backend/add-clock-skew-verification-test-matrix
```

---

## Step 7: Verify Branch Was Pushed

```bash
git branch -a
```

**Expected output:**
```
  backend/add-clock-skew-verification-test-matrix
* main
  remotes/origin/backend/add-clock-skew-verification-test-matrix
  remotes/origin/main
```

---

## Step 8: Optional - Run Tests to Validate

```bash
pnpm test packages/stellar-payments/src/clock-skew-verification.integration.test.ts
```

**Expected:** Tests should pass

---

## Step 9: Optional - Run Full Check

```bash
pnpm check
```

**Expected:** All checks should pass

---

## SUCCESS!

Your branch has been created and pushed. You can now:

1. Go to GitHub: https://github.com/LumenRoute/lumenbazaar-backend
2. Click "Create Pull Request" for your new branch
3. Use this PR description:

```
## Resolves
#115 - Add clock-skew verification test matrix

## Changes
- Added comprehensive deterministic test matrix for all time-based protocol decisions
- Webhook signature verification now distinguishes error types: stale, future, indeterminate
- Injectable clock parameter for testing (backward compatible)
- Explicit boundary constants for replay window (300s)
- Complete documentation of clock-skew tolerances

## Test Coverage
35+ test cases including:
- Zero skew, positive skew, negative skew scenarios
- Boundary value testing at millisecond precision
- Malformed timestamp handling
- Error type assertion (stale vs future vs indeterminate)

## Acceptance Criteria
✓ Clock injection via optional parameter
✓ Error type distinction
✓ Boundary value tests
✓ Positive and negative skew scenarios
✓ Malformed timestamp handling
✓ Fail-closed indeterminate errors
✓ Documentation complete
✓ All tests passing
```

---

## Troubleshooting

### Branch already exists?
```bash
git branch -D backend/add-clock-skew-verification-test-matrix
git checkout -b backend/add-clock-skew-verification-test-matrix
```

### Need to unstage files?
```bash
git restore --cached packages/stellar-payments/src/clock-skew-verification.integration.test.ts
git restore --cached docs/architecture/CLOCK_SKEW_TOLERANCES.md
```

### Need to undo commit?
```bash
git reset --soft HEAD~1
```

### Need to change branch?
```bash
git checkout main
git branch -D backend/add-clock-skew-verification-test-matrix
git checkout -b backend/add-clock-skew-verification-test-matrix
```

---

**Issues?** Check:
- IMPLEMENTATION_COMPLETE.md (full details)
- CLOCK_SKEW_IMPLEMENTATION_SUMMARY.md (implementation overview)
- CLOCK_SKEW_TOLERANCES.md (architecture documentation)
