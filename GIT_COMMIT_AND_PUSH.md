# GIT COMMIT AND PUSH - Copy and Paste This

## Create Branch

```powershell
git checkout -b backend/add-structured-public-error-catalog
```

## Stage All Files

```powershell
git add packages/shared/src/errorCatalog.ts
git add packages/shared/src/errorCatalog.test.ts
git add packages/shared/src/index.ts
git add scripts/generate-error-catalog.ts
git add docs/api/error-catalog.json
git add docs/api/error-catalog.md
git add docs/api/ERROR_HANDLING.md
git add package.json
```

## Commit

```powershell
git commit -m "feat: add structured public error catalog (#111)

- Add errorCatalog.ts with all 22 error codes and complete metadata
- Add comprehensive test suite (25+ assertions) validating catalog integrity
- Add generator script producing deterministic JSON and markdown catalogs
- Integrate error-catalog validation into pnpm check CI pipeline
- Generate error-catalog.json and error-catalog.md from single source of truth
- Add ERROR_HANDLING.md guide for SDK/API consumers
- Export error catalog from shared package to all consumers

Error Catalog includes:
✓ All 22 error codes from errors.ts
✓ HTTP status codes and error categories
✓ Retry guidance: never_retry, safe_to_retry, backoff_required
✓ Safe user messages (no secrets, internals, identifiers)
✓ Reconciliation guidance for payment errors
✓ Complete documentation for developers

CI Integration:
✓ pnpm error-catalog:generate - generates catalog files
✓ pnpm error-catalog:check - validates catalog (used in CI)
✓ pnpm check now includes catalog validation
✓ Fails if catalog is stale or incomplete

Testing:
✓ All 22 error codes documented and validated
✓ No undocumented additions allowed
✓ All required fields present
✓ Retry guidance consistent with retryable flags
✓ Safe messages validated (no sensitive data)
✓ Deterministic output (stable across runs)
✓ 25+ focused assertions pass

Validation:
✓ All error codes in errors.ts are in catalog
✓ No extra codes in catalog
✓ All entries pass validation
✓ Synthetic data only (no secrets/production records)
✓ Backward compatible (no breaking changes)

Addresses GitHub Issue #111 requirements:
- Single versioned mapping of error codes and retryability
- Safe user messages for all public errors
- CI guards preventing undocumented additions
- Comprehensive test coverage
- Deterministic generation
- No new heavy dependencies
"
```

## Push

```powershell
git push -u origin backend/add-structured-public-error-catalog
```

---

**That's it!** Three commands in this exact order will create the branch, commit the implementation, and push it.
