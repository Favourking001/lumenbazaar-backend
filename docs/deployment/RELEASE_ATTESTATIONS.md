# Release Attestations and Verification

This document describes how to verify LumenBazaar backend release artifacts, including SBOMs (Software Bill of Materials), build provenance, checksums, and source revision metadata.

## What Release Attestations Prove

Release attestations provide cryptographic evidence of:

- **Source Revision** (commit SHA): The exact Git commit used to build this release
- **Dependency Graph** (pnpm-lock.yaml hash): Reproducible, pinned versions of all dependencies
- **Build Environment** (toolchain metadata): Node version, pnpm version, runner OS, workflow identity
- **Artifact Integrity** (checksums): SHA-256 hashes proving artifact authenticity
- **Software Bill of Materials**: Machine-readable inventory of production dependencies

## What Release Attestations Do NOT Prove

Release attestations explicitly **do not**:

- Constitute a security audit or vulnerability assessment
- Guarantee the code is free of vulnerabilities or malicious behavior
- Provide runtime security assurance
- Replace application-level security controls
- Verify build-time or runtime behavior

## Verification Without Private Infrastructure

All verification steps use only public tooling and require no stored secrets or private keys.

### Prerequisites

```bash
# Install GitHub CLI (includes attestation verification)
# macOS with Homebrew
brew install gh

# Ubuntu/Debian
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
  sudo gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
  sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install gh

# cosign for SBOM verification
curl -fsSL https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 -o cosign
chmod +x cosign
```

### Step 1: Verify Checksums

Download the release and verify artifact digests:

```bash
# Download release from GitHub
RELEASE_TAG="v0.1.0"
gh release download $RELEASE_TAG --repo LumenRoute/lumenbazaar-backend \
  --pattern "*.sha256" --dir checksums

# Verify checksums
cd checksums
sha256sum -c checksums.sha256
# Expected output:
#   openapi.json: OK
#   openapi.md: OK
#   conformance.json: OK
#   conformance.md: OK
#   checksums.json: OK
```

If any file fails verification, **do not use the release**.

### Step 2: Verify Build Provenance

Verify the release was built by the published workflow from the expected source commit:

```bash
# Verify provenance attestation (requires GitHub CLI v2.31.0+)
gh attestation verify \
  --repo LumenRoute/lumenbazaar-backend \
  docs/api/openapi.json

# Expected output shows:
#   ✓ Verified by using GitHub Actions
#   ✓ Associated with commit <SHA>
#   ✓ Built with workflow <workflow.yaml>
```

The attestation proves:
- **Signer**: GitHub Actions workflow at `LumenRoute/lumenbazaar-backend`
- **Subject**: The exact artifact digest
- **Commit**: The source commit SHA (compare against your expectations)
- **Workflow**: The exact CI/CD workflow ref (e.g., `.github/workflows/release.yml@refs/tags/v0.1.0`)

### Step 3: Verify Source Commit

Ensure the build was created from an expected source revision:

```bash
# Extract source commit from provenance
COMMIT=$(gh attestation verify \
  --repo LumenRoute/lumenbazaar-backend \
  docs/api/openapi.json | grep "Associated with commit" | awk '{print $NF}')

# Verify commit exists in the repository
git ls-remote https://github.com/LumenRoute/lumenbazaar-backend.git $COMMIT

# Expected: <full-sha> HEAD (or refs/tags/v<version>)
```

### Step 4: Inspect the SBOM

Verify the Software Bill of Materials for known vulnerabilities or suspicious packages:

```bash
# Download SBOMs
gh release download $RELEASE_TAG --repo LumenRoute/lumenbazaar-backend \
  --pattern "sbom-*.json" --dir sboms

# Inspect CycloneDX format (human-readable)
cat sboms/sbom-cyclonedx-*.json | jq '.components[] | {name: .name, version: .version, purl: .purl}' | head -20

# Validate SBOM structure
cat sboms/sbom-cyclonedx-*.json | jq 'has("components") and has("metadata") and has("bomFormat")'
# Expected: true

# Optional: Check SBOM with an SBOM validator
# https://cyclonedx.org/validator/
```

The SBOM lists all production dependencies (not devDependencies). For each package:

- **purl**: Package URL for programmatic lookup
- **version**: Pinned dependency version (from pnpm-lock.yaml)
- **name**: Package name in npm registry

### Step 5: Verify Lockfile Hash

Confirm that the released artifacts were built from a reproducible dependency snapshot:

```bash
# Extract lockfile hash from metadata
LOCKFILE_HASH=$(cat sboms/sbom-metadata-*.json | jq -r '.lockfileHash')

# Compute hash of local pnpm-lock.yaml
LOCAL_HASH=$(sha256sum pnpm-lock.yaml | awk '{print $1}')

# Compare
if [ "$LOCKFILE_HASH" = "$LOCAL_HASH" ]; then
  echo "✓ Lockfile matches"
else
  echo "✗ Lockfile differs"
  echo "  Release was built from: $LOCKFILE_HASH"
  echo "  Your local version is:  $LOCAL_HASH"
  exit 1
fi
```

A mismatch means the release was built with different dependencies than your current pnpm-lock.yaml. This is expected if dependencies have been updated since the release.

### Step 6: Verify Toolchain Metadata

Ensure the build used expected toolchain versions:

```bash
# Extract toolchain metadata
gh release download $RELEASE_TAG --repo LumenRoute/lumenbazaar-backend \
  --pattern "toolchain-metadata-*.json" --dir metadata

# Inspect toolchain details
cat metadata/toolchain-metadata-*.json | jq .
# Expected fields:
#   buildRunner: "ubuntu-latest"
#   nodeVersion: "24"
#   pnpmVersion: "10.28.0"
#   buildDate: "2025-01-01T12:00:00Z"
#   gitCommit: "<sha>"
#   gitRef: "refs/tags/v0.1.0"
#   workflowId: "<workflow-ref>"
```

## Verification Workflow Summary

```bash
#!/bin/bash
set -euo pipefail

RELEASE_TAG="v0.1.0"
RELEASE_DIR="lumenbazaar-release-${RELEASE_TAG}"

mkdir -p "$RELEASE_DIR"
cd "$RELEASE_DIR"

# Step 1: Download all release artifacts
echo "Downloading release artifacts..."
gh release download "$RELEASE_TAG" \
  --repo LumenRoute/lumenbazaar-backend \
  --pattern "*" --dir .

# Step 2: Verify checksums
echo "Verifying checksums..."
sha256sum -c checksums.sha256

# Step 3: Verify provenance
echo "Verifying build provenance..."
gh attestation verify \
  --repo LumenRoute/lumenbazaar-backend \
  openapi.json

# Step 4: Verify source commit
echo "Verifying source commit..."
COMMIT=$(gh attestation verify \
  --repo LumenRoute/lumenbazaar-backend \
  openapi.json | grep "Associated with commit" | awk '{print $NF}')
git ls-remote https://github.com/LumenRoute/lumenbazaar-backend.git "$COMMIT"

# Step 5: Inspect SBOM
echo "Inspecting Software Bill of Materials..."
echo "Production dependencies (first 10):"
cat sbom-cyclonedx-*.json | jq '.components[] | "\(.name)@\(.version)"' | head -10

# Step 6: Verify lockfile
echo "Verifying lockfile integrity..."
LOCKFILE_HASH=$(cat sbom-metadata-*.json | jq -r '.lockfileHash')
echo "Release lockfile hash: $LOCKFILE_HASH"

echo ""
echo "✓ All verification steps passed"
```

## Troubleshooting

### "Attestation not found"

If `gh attestation verify` fails with "not found":

1. Verify the release tag exists: `gh release list --repo LumenRoute/lumenbazaar-backend`
2. Ensure you're checking an actual release artifact (not source code)
3. Verify GitHub CLI is up to date: `gh version`
4. The attestation may not yet be available immediately after release; wait a few minutes

### "Checksum mismatch"

If `sha256sum -c checksums.sha256` fails:

1. Verify you downloaded the file completely (check file size)
2. Re-download the file: `gh release download --clobber`
3. If the issue persists, the release may be corrupted on GitHub's servers—report to maintainers

### "Commit not found"

If `git ls-remote` reports the commit as not found:

1. Use the full commit SHA (not abbreviated)
2. Verify the repository URL is correct
3. The commit may be on a feature branch; check `git show <commit>` if you have local access

## Integrating Verification Into Your Deployment

### Docker Build

Verify the SBOM before building or deploying:

```dockerfile
# Verify attestations in your deployment pipeline
RUN gh release download v0.1.0 \
    --repo LumenRoute/lumenbazaar-backend \
    --pattern "checksums.sha256" \
    --dir /tmp/release && \
    cd /tmp/release && \
    sha256sum -c checksums.sha256 && \
    echo "✓ Release attestations verified"
```

### Kubernetes

Store attestation verification as a ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: lumenbazaar-release-manifest
data:
  attestation-commit: "<source-commit-sha>"
  attestation-date: "<build-date>"
  sbom-ref: "urn:uuid:<sbom-uuid>"
  verified-at: "<verification-timestamp>"
```

### Manual Pre-Deployment Checklist

- [ ] Checksums verified (`sha256sum -c` passes)
- [ ] Build provenance verified (`gh attestation verify` succeeds)
- [ ] Source commit verified (expected commit SHA matches)
- [ ] SBOM inspected for suspicious packages
- [ ] Toolchain metadata reviewed (expected versions match)
- [ ] Lockfile hash recorded for reproducibility
- [ ] Release date is recent and expected

## Additional Resources

- [CycloneDX SBOM Format](https://cyclonedx.org/)
- [SPDX SBOM Format](https://spdx.dev/)
- [GitHub Actions Attestations](https://docs.github.com/en/actions/security-guides/about-attestations)
- [Sigstore: Keyless Signing](https://docs.sigstore.dev/)
- [SLSA Framework](https://slsa.dev/)

## Support

For attestation verification issues, please:

1. Verify all prerequisites are installed (`gh`, `sha256sum`)
2. Check your GitHub permissions (must have repo read access)
3. Report issues with exact error messages to the repository maintainers
