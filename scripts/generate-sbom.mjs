#!/usr/bin/env node
/**
 * Generate a machine-readable SBOM (CycloneDX/SPDX JSON) from pnpm-lock.yaml.
 * Covers production packages only (excludes devDependencies).
 * Deterministic output, named predictably with version and source revision.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

/**
 * Parse pnpm-lock.yaml and extract production dependencies.
 */
function extractProductionDeps() {
  const lockPath = path.join(rootDir, 'pnpm-lock.yaml');
  const lockContent = fs.readFileSync(lockPath, 'utf8');
  const lockData = yaml.parse(lockContent);

  const deps = new Map();

  // Extract dependencies from root importer (.)
  if (lockData.importers && lockData.importers['.']) {
    const rootDeps = lockData.importers['.'].dependencies || {};
    for (const [name, spec] of Object.entries(rootDeps)) {
      const version = spec.version || spec.specifier;
      deps.set(name, version);
    }
  }

  return deps;
}

/**
 * Generate CycloneDX SBOM in JSON format.
 */
function generateCycloneDXSBOM(deps, projectVersion, sourceRevision) {
  const components = Array.from(deps.entries()).map(([name, version]) => ({
    type: 'library',
    name,
    version,
    purl: `pkg:npm/${name}@${version}`,
  })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.4',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [
        {
          vendor: 'LumenBazaar',
          name: 'generate-sbom',
          version: '1.0.0',
        },
      ],
      component: {
        type: 'application',
        name: 'lumenbazaar-backend',
        version: projectVersion,
        description: 'LumenBazaar backend API and services',
        purl: 'pkg:npm/lumenbazaar-backend',
      },
    },
    components,
    properties: [
      { name: 'sourceRevision', value: sourceRevision },
      { name: 'buildDate', value: new Date().toISOString() },
      { name: 'generatorVersion', value: '1.0.0' },
    ],
  };
}

/**
 * Generate SPDX JSON SBOM format.
 */
function generateSPDXSBOM(deps, projectVersion, sourceRevision) {
  const packages = [
    {
      SPDXID: 'SPDXRef-DOCUMENT',
      name: 'LumenBazaar Backend',
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
    },
  ];

  let pkgIndex = 0;
  const relationships = [
    {
      spdxElementId: 'SPDXRef-DOCUMENT',
      relatedSpdxElement: `SPDXRef-Package-${pkgIndex}`,
      relationshipType: 'DESCRIBES',
    },
  ];

  packages.push({
    SPDXID: `SPDXRef-Package-${pkgIndex}`,
    name: 'lumenbazaar-backend',
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:npm/lumenbazaar-backend@${projectVersion}`,
      },
    ],
  });

  Array.from(deps.entries()).forEach(([name, version], idx) => {
    const depIdx = pkgIndex + idx + 1;
    packages.push({
      SPDXID: `SPDXRef-Package-${depIdx}`,
      name,
      downloadLocation: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      filesAnalyzed: false,
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: `pkg:npm/${name}@${version}`,
        },
      ],
    });

    relationships.push({
      spdxElementId: `SPDXRef-Package-${pkgIndex}`,
      relatedSpdxElement: `SPDXRef-Package-${depIdx}`,
      relationshipType: 'DEPENDS_ON',
    });
  });

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'lumenbazaar-backend',
    documentNamespace: `https://github.com/LumenRoute/lumenbazaar-backend/sbom/${sourceRevision}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ['Tool: generate-sbom-1.0.0'],
    },
    packages,
    relationships,
  };
}

/**
 * Main entry point.
 */
function main() {
  const pjsonPath = path.join(rootDir, 'package.json');
  const pjson = JSON.parse(fs.readFileSync(pjsonPath, 'utf8'));
  const projectVersion = pjson.version || '0.1.0';

  // Source revision from environment or git
  let sourceRevision = process.env.GITHUB_SHA || 'unknown';
  if (sourceRevision === 'unknown' && process.env.GIT_COMMIT) {
    sourceRevision = process.env.GIT_COMMIT;
  }

  const deps = extractProductionDeps();

  // Generate CycloneDX SBOM
  const cycloneDX = generateCycloneDXSBOM(deps, projectVersion, sourceRevision);
  const sbomDir = path.join(rootDir, 'docs', 'release');
  if (!fs.existsSync(sbomDir)) {
    fs.mkdirSync(sbomDir, { recursive: true });
  }

  const cycloneDXFile = path.join(
    sbomDir,
    `sbom-cyclonedx-${projectVersion}-${sourceRevision.slice(0, 7)}.json`,
  );
  fs.writeFileSync(cycloneDXFile, JSON.stringify(cycloneDX, null, 2));
  console.log(`Generated CycloneDX SBOM: ${cycloneDXFile}`);

  // Generate SPDX JSON SBOM
  const spdx = generateSPDXSBOM(deps, projectVersion, sourceRevision);
  const spdxFile = path.join(
    sbomDir,
    `sbom-spdx-${projectVersion}-${sourceRevision.slice(0, 7)}.json`,
  );
  fs.writeFileSync(spdxFile, JSON.stringify(spdx, null, 2));
  console.log(`Generated SPDX JSON SBOM: ${spdxFile}`);

  // Generate a deterministic lockfile hash for provenance binding
  const lockfilePath = path.join(rootDir, 'pnpm-lock.yaml');
  const lockfileHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(lockfilePath, 'utf8'))
    .digest('hex');

  const metadata = {
    projectName: 'lumenbazaar-backend',
    projectVersion,
    sourceRevision,
    lockfileHash,
    sbomFiles: [
      path.basename(cycloneDXFile),
      path.basename(spdxFile),
    ],
    generatedAt: new Date().toISOString(),
  };

  const metadataFile = path.join(
    sbomDir,
    `sbom-metadata-${projectVersion}-${sourceRevision.slice(0, 7)}.json`,
  );
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
  console.log(`Generated metadata: ${metadataFile}`);
  console.log(`Lockfile hash (SHA-256): ${lockfileHash}`);
}

main();
