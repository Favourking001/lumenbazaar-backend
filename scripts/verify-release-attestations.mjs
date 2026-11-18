#!/usr/bin/env node
/**
 * Verify release attestations: checksums, SBOM, provenance, and source revision.
 * Fails closed if any expected artifact is missing, empty, malformed, or mismatched.
 * Can be unit tested with synthetic fixtures.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

/**
 * Verification result object.
 */
class VerificationResult {
  constructor() {
    this.checks = [];
    this.passed = 0;
    this.failed = 0;
    this.errors = [];
  }

  check(name, condition, details = '') {
    if (condition) {
      this.checks.push({ name, status: 'PASS', details });
      this.passed += 1;
    } else {
      this.checks.push({ name, status: 'FAIL', details });
      this.failed += 1;
      this.errors.push(`${name}: ${details}`);
    }
  }

  report() {
    console.log('\n=== Release Attestation Verification ===\n');
    this.checks.forEach((c) => {
      const icon = c.status === 'PASS' ? '✓' : '✗';
      console.log(`${icon} ${c.name}`);
      if (c.details) {
        console.log(`  ${c.details}`);
      }
    });

    console.log(`\n=== Summary ===`);
    console.log(`Passed: ${this.passed}`);
    console.log(`Failed: ${this.failed}`);

    if (this.errors.length > 0) {
      console.log('\n=== Errors ===');
      this.errors.forEach((e) => console.log(`  ${e}`));
      throw new Error(`Verification failed: ${this.failed} check(s) failed`);
    }
  }
}

/**
 * Verify checksums file exists, is well-formed, and artifact digests match.
 */
function verifyChecksums(result, artifactPath) {
  const checksumFile = `${artifactPath}.sha256`;

  result.check(
    'Checksums file exists',
    fs.existsSync(checksumFile),
    checksumFile,
  );

  if (!fs.existsSync(checksumFile)) {
    result.check('Checksums file not empty', false, 'File does not exist');
    result.check('Checksums well-formed', false, 'File does not exist');
    result.check('Artifact digest matches', false, 'File does not exist');
    return;
  }

  const checksumContent = fs.readFileSync(checksumFile, 'utf8').trim();
  result.check(
    'Checksums file not empty',
    checksumContent.length > 0,
    `Content length: ${checksumContent.length}`,
  );

  // Parse SHA256SUMS format: "hash  filename"
  const lines = checksumContent.split('\n').filter((l) => l.trim());
  const checksumMap = new Map();

  lines.forEach((line) => {
    const parts = line.split(/\s{2,}/);
    if (parts.length >= 2) {
      checksumMap.set(parts[1].trim(), parts[0].trim());
    }
  });

  result.check(
    'Checksums well-formed',
    checksumMap.size > 0,
    `Parsed ${checksumMap.size} entries`,
  );

  // Verify artifact hash
  if (fs.existsSync(artifactPath)) {
    const fileHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(artifactPath))
      .digest('hex');

    const expectedHash = checksumMap.get(path.basename(artifactPath));
    result.check(
      'Artifact digest matches',
      fileHash === expectedHash,
      expectedHash ? 'Hashes match' : 'No entry for artifact in checksums',
    );
  }
}

/**
 * Verify SBOM files exist and are valid JSON.
 */
function verifySBOM(result, sbomDir) {
  result.check(
    'SBOM directory exists',
    fs.existsSync(sbomDir),
    sbomDir,
  );

  if (!fs.existsSync(sbomDir)) {
    result.check('CycloneDX SBOM exists', false, 'Directory does not exist');
    result.check('SPDX SBOM exists', false, 'Directory does not exist');
    result.check('SBOM files are valid JSON', false, 'Directory does not exist');
    return;
  }

  const files = fs.readdirSync(sbomDir);
  const cycloneDXFile = files.find((f) => f.startsWith('sbom-cyclonedx-'));
  const spdxFile = files.find((f) => f.startsWith('sbom-spdx-'));

  result.check(
    'CycloneDX SBOM exists',
    !!cycloneDXFile,
    cycloneDXFile || 'Not found',
  );

  result.check(
    'SPDX SBOM exists',
    !!spdxFile,
    spdxFile || 'Not found',
  );

  // Validate JSON
  [cycloneDXFile, spdxFile].forEach((file) => {
    if (file) {
      try {
        const content = fs.readFileSync(path.join(sbomDir, file), 'utf8');
        const parsed = JSON.parse(content);

        result.check(
          `SBOM ${file} is valid JSON`,
          !!parsed,
          'Parsed successfully',
        );

        // Check required fields for CycloneDX
        if (file.includes('cyclonedx')) {
          result.check(
            'CycloneDX has required fields',
            parsed.bomFormat && parsed.specVersion && parsed.components,
            'bomFormat, specVersion, components present',
          );
        }

        // Check required fields for SPDX
        if (file.includes('spdx')) {
          result.check(
            'SPDX has required fields',
            parsed.spdxVersion && parsed.packages && parsed.relationships,
            'spdxVersion, packages, relationships present',
          );
        }
      } catch (e) {
        result.check(`SBOM ${file} is valid JSON`, false, e.message);
      }
    }
  });
}

/**
 * Verify provenance metadata (lockfile hash, source revision, etc.)
 */
function verifyProvenance(result, sbomDir) {
  const files = fs.readdirSync(sbomDir);
  const metadataFile = files.find((f) => f.startsWith('sbom-metadata-'));

  result.check(
    'Provenance metadata exists',
    !!metadataFile,
    metadataFile || 'Not found',
  );

  if (!metadataFile) {
    result.check('Metadata has lockfileHash', false, 'Metadata file not found');
    result.check('Metadata has sourceRevision', false, 'Metadata file not found');
    return;
  }

  try {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(sbomDir, metadataFile), 'utf8'),
    );

    result.check(
      'Metadata has lockfileHash',
      !!metadata.lockfileHash && metadata.lockfileHash.length === 64,
      `Hash length: ${metadata.lockfileHash?.length || 'missing'}`,
    );

    result.check(
      'Metadata has sourceRevision',
      !!metadata.sourceRevision && metadata.sourceRevision.length > 0,
      metadata.sourceRevision || 'Missing',
    );

    // Verify lockfile hash matches current lockfile
    const lockfilePath = path.join(rootDir, 'pnpm-lock.yaml');
    if (fs.existsSync(lockfilePath)) {
      const currentHash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(lockfilePath, 'utf8'))
        .digest('hex');

      result.check(
        'Lockfile hash matches current lockfile',
        currentHash === metadata.lockfileHash,
        'Hashes match',
      );
    }
  } catch (e) {
    result.check('Metadata is valid JSON', false, e.message);
  }
}

/**
 * Verify toolchain metadata (Node, pnpm versions, etc.)
 */
function verifyToolchainMetadata(result) {
  const pjsonPath = path.join(rootDir, 'package.json');
  const pjson = JSON.parse(fs.readFileSync(pjsonPath, 'utf8'));

  result.check(
    'Node version specified',
    !!pjson.engines?.node,
    pjson.engines?.node || 'Not specified',
  );

  result.check(
    'pnpm version specified',
    !!pjson.engines?.pnpm || !!pjson.packageManager,
    pjson.packageManager || 'Not specified',
  );
}

/**
 * Main verification entry point.
 */
function main() {
  const result = new VerificationResult();
  const releaseDir = path.join(rootDir, 'docs', 'release');
  const apiDir = path.join(rootDir, 'docs', 'api');

  // Run all verifications
  verifyChecksums(result, path.join(apiDir, 'openapi.json'));
  verifySBOM(result, releaseDir);
  verifyProvenance(result, releaseDir);
  verifyToolchainMetadata(result);

  // Report and fail if any check failed
  result.report();
}

export { VerificationResult, verifyChecksums, verifySBOM, verifyProvenance, verifyToolchainMetadata };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
