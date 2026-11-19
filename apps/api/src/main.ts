import { buildApiApp } from "./app.js";
import { loadConfig } from "@lumenbazaar/shared";
import {
  createEventStreamSigningSecretProbe,
  createFacilitatorSignerSecretProbe,
  createRuntimeFacilitatorSignerProvider,
  formatSecretProviderCheckLog,
  runSecretProviderStartupChecks,
  type FacilitatorSignerProvider
} from "@lumenbazaar/stellar-payments";

const config = loadConfig();

// The KMS runtime provider factory fails closed (throws) when a KMS adapter
// is configured but not wired. Treat that as a failed secret-provider check
// for the facilitator signer instead of crashing startup, so only the
// payment capabilities that require the signer are blocked.
let signerProvider: FacilitatorSignerProvider | undefined;
try {
  signerProvider = createRuntimeFacilitatorSignerProvider(config);
} catch {
  signerProvider = undefined;
}

// Startup secret-provider health checks (issue #113): validate reachability,
// key existence/metadata and required permissions for each configured secret
// provider before serving traffic — without signing any production payload
// and without logging secret material. A failed check blocks only the
// capability that requires that secret; unrelated services still start.
// Providers that are not configured at all are not probed: their capability
// is simply not enabled, and readiness reports `secretProviders` as
// `not_required`.
const secretProviderReport = await runSecretProviderStartupChecks(
  [
    ...(config.signer.provider === "disabled"
      ? []
      : [createFacilitatorSignerSecretProbe(signerProvider, config)]),
    ...(config.eventStreams.signingSecret === undefined
      ? []
      : [createEventStreamSigningSecretProbe(config.eventStreams.signingSecret)])
  ],
  { timeoutMs: 5_000 }
);

for (const result of secretProviderReport.results) {
  const line = JSON.stringify(formatSecretProviderCheckLog(result));
  if (result.ok) {
    console.log(line);
  } else {
    console.error(line);
  }
}

// Fail closed per capability: drop the signer provider when its startup
// check failed, so the exact/upto schemes are not advertised. The API still
// starts and serves everything that does not require the signer.
const signerBlocked = secretProviderReport.blockedCapabilities.includes("facilitator_signer");
const effectiveSignerProvider = signerBlocked ? undefined : signerProvider;

const app = buildApiApp({
  config,
  // Only forward the signer provider when one was actually configured and
  // passed its startup secret-provider check; otherwise leave the option
  // absent so downstream code can detect the "no signer" case explicitly.
  ...(effectiveSignerProvider === undefined ? {} : { signerProvider: effectiveSignerProvider }),
  secretProviderStartupReport: secretProviderReport
});

await app.listen({ host: config.api.host, port: config.api.port });
