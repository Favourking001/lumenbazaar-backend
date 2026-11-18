# API Release Verification Guide

This document provides operators and developers with commands to verify the integrity and provenance of LumenBazaar backend API releases.

## Quick Verification (5 minutes)

```bash
# 1. Set release version
RELEASE="v0.1.0"

# 2. Download all release artifacts
gh release download "$RELEASE" \
  --repo LumenRoute/lumenbazaar-backend \
  --pattern "*" \
  --dir lumenbazaar-api-release

cd lumenbazaar-api-release

# 3. Verify checksums
sha256sum -c checksums.sha256
# Expected: all files OK

# 4. Verify build provenance (GitHub Actions)
gh attestation verify \
  --repo LumenRoute/lumenbazaar-backend \
  openapi.json
# Expected: ✓ Verified by using GitHub Actions

echo "✓ API release is authentic and unmodified"
```

## Detailed Verification Steps

### 1. Checksum Verification

SHA-256 checksums prove artifact integrity:

```bash
# Download checksums file
gh release download "$RELEASE" \
  --repo LumenRoute/lumenbazaar-backend \
  --pattern "checksums.sha256" \
  --dir .

# Verify all artifacts
sha256sum -c checksums.sha256

# Expected output:
# openapi.json: OK
# openapi.md: OK
# conformance.json: OK
# conformance.md: OK
# checksums.json: OK
```

**What this proves**: The artifacts have not been modified or corrupted since release.

**What this does not prove**: The artifacts are not malicious (cryptographic proof of identity requires provenance attestation, below).

### 2. Provenance Attestation (Build Trust)

Verify that artifacts were built by the published GitHub Actions workflow:

```bash
# Verify provenance for each artifact
for artifact in openapi.json openapi.md conformance.json; do
  echo "Verifying $artifact..."
  gh attestation verify \
    --repo LumenRoute/lumenbazaar-backend \
    "$artifact"
done
```

**Expected output**:
```
✓ Verification succeeded!

Verified by using GitHub Actions
Associated with commit abc1234567890def...
Built with workflow .github/workflows/release.yml
Reference: refs/tags/v0.1.0
...
```

**What this proves**:
- Artifact was built by LumenRoute/lumenbazaar-backend repository
- Built by the published release workflow (not a custom script)
- Built from the exact source commit specified
- Signer is GitHub's infrastructure (keyless, via OpenID Connect)

**What this does not prove**:
- The source code is free of vulnerabilities
- The build process prevented all malicious modifications
- The released features are secure for production use

### 3. Source Commit Verification

Ensure the build was created from an expected source revision:

```bash
# Extract commit SHA from attestation
COMMIT=$(gh attestation verify \
  --repo LumenRoute/lumenbazaar-backend \
  openapi.json 2>&1 | grep "Associated with commit" | awk '{print $NF}')

echo "Release built from commit: $COMMIT"

# Verify commit exists in repository
git ls-remote https://github.com/LumenRoute/lumenbazaar-backend.git "$COMMIT"
# Expected: <sha> <ref>

# Verify commit is on expected branch/tag
git ls-remote https://github.com/LumenRoute/lumenbazaar-backend.git \
  | grep "$COMMIT"
# Should list the release tag (refs/tags/v0.1.0)
```

### 4. Software Bill of Materials (SBOM) Inspection

Review all production dependencies:

```bash
# Download SBOM
gh release download "$RELEASE" \
  --repo LumenRoute/lumenbazaar-backend \
  --pattern "sbom-cyclonedx-*.json" \
  --dir .

# View production dependencies
cat sbom-cyclonedx-*.json | jq '.components[] | {name: .name, version: .version}'

# Expected: All npm packages with pinned versions
# Examples:
#   {
#     "name": "fastify",
#     "version": "5.12.5"
#   },
#   {
#     "name": "@stellar/stellar-sdk",
#     "version": "17.2.1"
#   }

# Count total dependencies
cat sbom-cyclonedx-*.json | jq '.components | length'
```

**Using the SBOM**:

- Search for specific packages: `jq '.components[] | select(.name == "fastify")'`
- Check SBOM format compliance: `jq '.bomFormat'` (expected: "CycloneDX")
- Verify SBOM integrity: `jq 'has("components") and has("metadata")'` (expected: true)

### 5. Lockfile Hash Verification

Ensure dependencies are reproducible and pinned:

```bash
# Download SBOM metadata
gh release download "$RELEASE" \
  --repo LumenRoute/lumenbazaar-backend \
  --pattern "sbom-metadata-*.json" \
  --dir .

# Extract lockfile hash
LOCKFILE_HASH=$(cat sbom-metadata-*.json | jq -r '.lockfileHash')
echo "Release lockfile SHA-256: $LOCKFILE_HASH"

# If you have access to source at that commit:
git show "$COMMIT:pnpm-lock.yaml" | sha256sum
# Should match $LOCKFILE_HASH

# Without source access:
# Compare against your local pnpm-lock.yaml
LOCAL_HASH=$(sha256sum pnpm-lock.yaml | awk '{print $1}')
if [ "$LOCKFILE_HASH" = "$LOCAL_HASH" ]; then
  echo "✓ Lockfile matches your current version"
else
  echo "✗ Lockfile differs (expected if dependencies have been updated)"
fi
```

### 6. Toolchain Metadata Review

Verify the build used expected toolchain versions:

```bash
# Download toolchain metadata
gh release download "$RELEASE" \
  --repo LumenRoute/lumenbazaar-backend \
  --pattern "toolchain-metadata-*.json" \
  --dir .

# View all metadata
cat toolchain-metadata-*.json | jq .

# Expected:
# {
#   "buildRunner": "ubuntu-latest",
#   "nodeVersion": "24",
#   "pnpmVersion": "10.28.0",
#   "buildDate": "2025-01-15T10:30:00Z",
#   "gitCommit": "abc1234567890def...",
#   "gitRef": "refs/tags/v0.1.0",
#   "workflowId": "LumenRoute/lumenbazaar-backend/.github/workflows/release.yml@refs/tags/v0.1.0"
# }

# Verify expected toolchain versions
cat toolchain-metadata-*.json | jq '{nodeVersion: .nodeVersion, pnpmVersion: .pnpmVersion, buildRunner: .buildRunner}'
```

## Continuous Verification

### In Your CI/CD Pipeline

```yaml
# GitHub Actions example
- name: Verify API release
  run: |
    RELEASE_TAG="v0.1.0"
    
    # Download and verify
    gh release download $RELEASE_TAG \
      --repo LumenRoute/lumenbazaar-backend \
      --pattern "checksums.sha256" \
      --dir .
    
    sha256sum -c checksums.sha256
    
    gh attestation verify \
      --repo LumenRoute/lumenbazaar-backend \
      openapi.json
```

### Docker Verification

```dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y gh

WORKDIR /app

# Download and verify release artifacts
RUN gh release download v0.1.0 \
    --repo LumenRoute/lumenbazaar-backend \
    --pattern "openapi.json" \
    --dir . && \
    gh release download v0.1.0 \
    --repo LumenRoute/lumenbazaar-backend \
    --pattern "checksums.sha256" \
    --dir . && \
    sha256sum -c checksums.sha256 && \
    echo "✓ Release verified"

COPY . .
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `gh: command not found` | Install GitHub CLI: https://cli.github.com/manual/installation |
| `Attestation not found` | Wait a few minutes for attestation to be published; verify you're checking the right artifact |
| `Checksum mismatch` | Re-download the file; verify file download completed successfully |
| `Permission denied` | Ensure you're authenticated: `gh auth login` |

## Verification Checklist for Deployment

Before deploying the API to production:

- [ ] Checksums verified (`sha256sum -c` passes)
- [ ] Provenance attestation verified (`gh attestation verify` succeeds)
- [ ] Source commit verified and reviewed
- [ ] SBOM reviewed for known vulnerable packages
- [ ] Toolchain versions match expected (Node 24, pnpm 10.28.0)
- [ ] Release date is recent
- [ ] All dependencies are from official npm registry

## References

- [Full Release Verification Guide](../deployment/RELEASE_ATTESTATIONS.md)
- [GitHub Attestations Documentation](https://docs.github.com/en/actions/security-guides/about-attestations)
- [CycloneDX SBOM Format](https://cyclonedx.org/)
- [SLSA Framework: Build Provenance](https://slsa.dev/spec/v1.0/provenance)
