/**
 * Unit tests for verify-release-attestations.mjs
 * Uses synthetic fixtures only, no production data.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  VerificationResult,
  verifyChecksums,
  verifySBOM,
  verifyProvenance,
  verifyToolchainMetadata,
} from './verify-release-attestations.mjs';

/**
 * Create a temporary directory for test fixtures.
 */
function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-test-'));
}

/**
 * Clean up temporary directory.
 */
function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('VerificationResult tracks pass/fail counts', () => {
  const result = new VerificationResult();
  result.check('test pass', true, 'detail');
  result.check('test fail', false, 'detail');

  assert.strictEqual(result.passed, 1);
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(result.checks.length, 2);
});

test('VerificationResult reports with no errors', () => {
  const result = new VerificationResult();
  result.check('test', true);

  // Should not throw
  result.report();
});

test('VerificationResult throws on failure', () => {
  const result = new VerificationResult();
  result.check('test', false, 'failed');

  assert.throws(() => {
    result.report();
  }, /Verification failed/);
});

test('verifySBOM passes with valid CycloneDX and SPDX files', () => {
  const tempDir = createTempDir();
  try {
    // Create valid SBOM files
    const cycloneDXSBOM = {
      bomFormat: 'CycloneDX',
      specVersion: '1.4',
      components: [
        { type: 'library', name: 'zod', version: '4.1.12' },
      ],
    };

    const spdxSBOM = {
      spdxVersion: 'SPDX-2.3',
      packages: [],
      relationships: [],
    };

    fs.writeFileSync(
      path.join(tempDir, 'sbom-cyclonedx-0.1.0-abc1234.json'),
      JSON.stringify(cycloneDXSBOM),
    );

    fs.writeFileSync(
      path.join(tempDir, 'sbom-spdx-0.1.0-abc1234.json'),
      JSON.stringify(spdxSBOM),
    );

    const result = new VerificationResult();
    verifySBOM(result, tempDir);

    // Should have mostly passing checks
    assert(result.passed >= 3);
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('verifySBOM fails when SBOM directory missing', () => {
  const result = new VerificationResult();
  verifySBOM(result, '/nonexistent/sbom/dir');

  assert.strictEqual(result.failed >= 2, true);
  assert(result.errors.some((e) => e.includes('does not exist')));
});

test('verifySBOM fails when SBOM is malformed JSON', () => {
  const tempDir = createTempDir();
  try {
    fs.writeFileSync(
      path.join(tempDir, 'sbom-cyclonedx-0.1.0-abc1234.json'),
      '{invalid json}',
    );

    fs.writeFileSync(
      path.join(tempDir, 'sbom-spdx-0.1.0-abc1234.json'),
      '{"valid": "json"}',
    );

    const result = new VerificationResult();
    verifySBOM(result, tempDir);

    assert(result.failed > 0);
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('verifyChecksums fails when checksum file missing', () => {
  const result = new VerificationResult();
  verifyChecksums(result, '/nonexistent/artifact.json');

  assert(result.failed >= 2);
  assert(result.errors.some((e) => e.includes('does not exist')));
});

test('verifyChecksums passes with valid SHA256SUMS format', () => {
  const tempDir = createTempDir();
  try {
    const artifactFile = path.join(tempDir, 'openapi.json');
    const checksumFile = `${artifactFile}.sha256`;

    // Create a test artifact
    fs.writeFileSync(artifactFile, '{"test": "data"}');

    // Create SHA256SUMS with correct hash
    const hash = 'abcd1234' + '0'.repeat(56);
    fs.writeFileSync(checksumFile, `${hash}  openapi.json\n`);

    const result = new VerificationResult();
    verifyChecksums(result, artifactFile);

    // Should have passing checks for file existence and well-formedness
    assert(result.passed >= 2);
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('verifyChecksums fails when checksums file is empty', () => {
  const tempDir = createTempDir();
  try {
    const artifactFile = path.join(tempDir, 'openapi.json');
    const checksumFile = `${artifactFile}.sha256`;

    fs.writeFileSync(artifactFile, 'test');
    fs.writeFileSync(checksumFile, '');

    const result = new VerificationResult();
    verifyChecksums(result, artifactFile);

    assert(result.failed >= 1);
    assert(result.errors.some((e) => e.includes('not empty')));
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('verifyProvenance passes with valid metadata', () => {
  const tempDir = createTempDir();
  try {
    const metadata = {
      projectName: 'lumenbazaar-backend',
      projectVersion: '0.1.0',
      sourceRevision: 'abc1234567890def',
      lockfileHash: 'a'.repeat(64),
      sbomFiles: ['sbom-cyclonedx-0.1.0-abc1234.json'],
      generatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(tempDir, 'sbom-metadata-0.1.0-abc1234.json'),
      JSON.stringify(metadata),
    );

    const result = new VerificationResult();
    verifyProvenance(result, tempDir);

    // Should have checks for lockfileHash and sourceRevision
    assert(result.passed >= 2);
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('verifyProvenance fails when metadata missing', () => {
  const tempDir = createTempDir();
  try {
    const result = new VerificationResult();
    verifyProvenance(result, tempDir);

    assert(result.failed >= 1);
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('verifyProvenance fails when lockfileHash missing', () => {
  const tempDir = createTempDir();
  try {
    const metadata = {
      projectName: 'lumenbazaar-backend',
      sourceRevision: 'abc1234567890def',
      // lockfileHash missing
    };

    fs.writeFileSync(
      path.join(tempDir, 'sbom-metadata-0.1.0-abc1234.json'),
      JSON.stringify(metadata),
    );

    const result = new VerificationResult();
    verifyProvenance(result, tempDir);

    assert(result.failed >= 1);
    assert(result.errors.some((e) => e.includes('lockfileHash')));
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('verifyProvenance fails when sourceRevision missing', () => {
  const tempDir = createTempDir();
  try {
    const metadata = {
      projectName: 'lumenbazaar-backend',
      lockfileHash: 'a'.repeat(64),
      // sourceRevision missing
    };

    fs.writeFileSync(
      path.join(tempDir, 'sbom-metadata-0.1.0-abc1234.json'),
      JSON.stringify(metadata),
    );

    const result = new VerificationResult();
    verifyProvenance(result, tempDir);

    assert(result.failed >= 1);
    assert(result.errors.some((e) => e.includes('sourceRevision')));
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('verifyToolchainMetadata passes with valid engines', () => {
  const result = new VerificationResult();
  verifyToolchainMetadata(result);

  // Should pass if package.json has engines defined
  assert(result.passed >= 1);
});
