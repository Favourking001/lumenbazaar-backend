# Configuration Reference

> Generated from the authoritative runtime schema — do not edit by hand.
> Regenerate with `pnpm config:reference`. CI fails when this file drifts
> from the schema (`pnpm config:reference:check`).
>
> Source of truth: `packages/shared/src/config.ts` (`envSchema` plus
> `configKeyMetadata`). Type, required/optional, and default semantics are
> introspected from the zod schema; ownership, sensitivity, and descriptions
> come from the metadata table. The "Additional runtime keys" section lists
> keys read directly from `process.env` outside `loadConfig`; those keys
> are not validated by the schema.
>
> Secret values are never printed: keys marked `secret` show `<redacted>`
> instead of any value or default. This document contains no secret values.
> Supply secrets through the hosting provider's secret manager, never by
> committing them.

## Runtime

| Key             | Type                                                  | Required | Default                                     | Sensitivity | Owner                   | Description                                                                                                                                                                 |
| --------------- | ----------------------------------------------------- | -------- | ------------------------------------------- | ----------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LUMEN_ENV`     | enum (`local` \| `testnet` \| `staging` \| `mainnet`) | Optional | `local`                                     | non-secret  | api, mcp-server, worker | Deployment environment: local, testnet, staging, or mainnet. Selects the active Stellar network. mainnet selects stellar:pubnet; every other value selects stellar:testnet. |
| `NODE_ENV`      | enum (`development` \| `test` \| `production`)        | Optional | `development` (`test` when `NODE_ENV=test`) | non-secret  | api, mcp-server, worker | Node runtime mode: development, test, or production. Hosted-environment placeholder checks only run when production.                                                        |
| `TESTNET_ASSET` | string                                                | Optional | `usdc`                                      | non-secret  | api, worker             | Exact-payment asset on testnet: usdc (official Stellar testnet USDC) or lbt (custom test-only asset). lbt is rejected on mainnet; only USDC is supported for production.    |

## API service

| Key                    | Type         | Required | Default                                                         | Sensitivity | Owner           | Description                                                                                                                                         |
| ---------------------- | ------------ | -------- | --------------------------------------------------------------- | ----------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_HOST`             | string       | Optional | `0.0.0.0`                                                       | non-secret  | api             | Host interface the API server binds to.                                                                                                             |
| `API_PORT`             | integer      | Optional | `3000`                                                          | non-secret  | api             | Port the API server listens on.                                                                                                                     |
| `API_PUBLIC_URL`       | string (URL) | Optional | `http://localhost:3000`                                         | non-secret  | api             | Public base URL of the API, used in readiness checks and advertised endpoints. Must not be a localhost or placeholder value in hosted environments. |
| `CORS_ALLOWED_ORIGINS` | string       | Optional | `http://localhost:3000,https://lumenbazaar-frontend.vercel.app` | non-secret  | api             | Comma-separated list of origins allowed by API CORS. At least one origin is required.                                                               |
| `MCP_PUBLIC_URL`       | string (URL) | Optional | `http://localhost:3001/mcp`                                     | non-secret  | api, mcp-server | Public URL of the MCP Streamable HTTP endpoint. Must not be a localhost or placeholder value in hosted environments.                                |

## Data stores

| Key            | Type         | Required | Default      | Sensitivity | Owner       | Description                                                                                                                                                                                                 |
| -------------- | ------------ | -------- | ------------ | ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | string       | Optional | `<redacted>` | secret      | api, worker | Postgres connection string used by the Prisma client. Connection string; supply via the hosting provider's secret manager in hosted environments. The schema default is a local-development value only.     |
| `REDIS_URL`    | string (URL) | Optional | `<redacted>` | secret      | api, worker | Redis connection string used by queues and rate limiting. Connection string; supply via the hosting provider's secret manager in hosted environments. The schema default is a local-development value only. |

## Features and assets

| Key                  | Type    | Required | Default | Sensitivity | Owner       | Description                                                                                                                                         |
| -------------------- | ------- | -------- | ------- | ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_ASSET_CODE` | string  | Optional | `USDC`  | non-secret  | api, worker | Default asset code accepted for exact payments. Validated and upper-cased at startup. Validated by loadConfig; not currently surfaced in AppConfig. |
| `ENABLE_UPTO_SCHEME` | boolean | Optional | `false` | non-secret  | api, worker | Enables the UPTO payment scheme when true. Requires the active asset and upto session contract IDs in hosted environments.                          |

## Stellar testnet

| Key                                        | Type         | Required | Default                                                    | Sensitivity | Owner       | Description                                                                                                                                                |
| ------------------------------------------ | ------------ | -------- | ---------------------------------------------------------- | ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_TESTNET_HORIZON_URL`              | string (URL) | Optional | `https://horizon-testnet.stellar.org`                      | non-secret  | api, worker | Horizon API URL for Stellar testnet.                                                                                                                       |
| `STELLAR_TESTNET_RPC_URL`                  | string (URL) | Optional | `https://soroban-testnet.stellar.org`                      | non-secret  | api, worker | Primary Soroban RPC URL for Stellar testnet.                                                                                                               |
| `STELLAR_TESTNET_RPC_URLS`                 | string       | Optional | No default                                                 | non-secret  | api, worker | Optional comma-separated list of Soroban RPC URLs for Stellar testnet (failover). Falls back to STELLAR_TESTNET_RPC_URL when unset.                        |
| `STELLAR_TESTNET_UPTO_SESSION_CONTRACT_ID` | string       | Optional | No default                                                 | non-secret  | api, worker | Soroban contract ID of the upto session contract on testnet, when deployed. Required when ENABLE_UPTO_SCHEME is true in hosted environments.               |
| `STELLAR_TESTNET_USDC_CONTRACT_ID`         | string       | Optional | No default                                                 | non-secret  | api, worker | Soroban contract ID of the testnet USDC asset contract, when deployed.                                                                                     |
| `STELLAR_TESTNET_USDC_ISSUER`              | string       | Optional | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | non-secret  | api, worker | Issuer of official Stellar testnet USDC (Circle). Public identifier. Only used when TESTNET_ASSET=usdc (the default).                                      |
| `TESTNET_LBT_CONTRACT_ID`                  | string       | Optional | No default                                                 | non-secret  | api, worker | Soroban contract ID of the LBT test-only asset contract, when deployed. Only used when TESTNET_ASSET=lbt.                                                  |
| `TESTNET_LBT_ISSUER`                       | string       | Optional | No default                                                 | non-secret  | api, worker | Issuer of the custom Lumen Bazaar test-only (LBT) asset. Only used when TESTNET_ASSET=lbt. Defaults at runtime to the local placeholder issuer when unset. |

## Stellar pubnet (mainnet)

| Key                                       | Type         | Required | Default                                                    | Sensitivity | Owner       | Description                                                                                                                                                                                                           |
| ----------------------------------------- | ------------ | -------- | ---------------------------------------------------------- | ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_PUBNET_HORIZON_URL`              | string (URL) | Optional | `https://horizon.stellar.org`                              | non-secret  | api, worker | Horizon API URL for Stellar pubnet (mainnet).                                                                                                                                                                         |
| `STELLAR_PUBNET_RPC_URL`                  | string (URL) | Optional | `https://mainnet.sorobanrpc.com`                           | non-secret  | api, worker | Primary Soroban RPC URL for Stellar pubnet (mainnet).                                                                                                                                                                 |
| `STELLAR_PUBNET_RPC_URLS`                 | string       | Optional | No default                                                 | non-secret  | api, worker | Optional comma-separated list of Soroban RPC URLs for Stellar pubnet (failover). Falls back to STELLAR_PUBNET_RPC_URL when unset.                                                                                     |
| `STELLAR_PUBNET_UPTO_SESSION_CONTRACT_ID` | string       | Optional | No default                                                 | non-secret  | api, worker | Soroban contract ID of the upto session contract on pubnet, when deployed. Required when ENABLE_UPTO_SCHEME is true in hosted environments.                                                                           |
| `STELLAR_PUBNET_USDC_CONTRACT_ID`         | string       | Optional | No default                                                 | non-secret  | api, worker | Soroban contract ID of the pubnet USDC asset contract, when deployed.                                                                                                                                                 |
| `STELLAR_PUBNET_USDC_ISSUER`              | string       | Optional | `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF` | non-secret  | api, worker | Issuer of USDC on Stellar pubnet. Public identifier. The schema default is the local placeholder issuer and must be replaced before mainnet startup; loadConfig fails on mainnet while the placeholder is configured. |

## Facilitator and signing

| Key                               | Type                                         | Required | Default                                                    | Sensitivity | Owner                         | Description                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------- | -------- | ---------------------------------------------------------- | ----------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACILITATOR_ACCOUNT`             | string                                       | Optional | `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF` | non-secret  | api, worker, stellar-payments | Stellar account that facilitates exact payments. Public identifier. The schema default is the local placeholder account and must be replaced in hosted environments.                                           |
| `FACILITATOR_KMS_ENDPOINT`        | string                                       | Optional | No default                                                 | non-secret  | stellar-payments              | Optional custom endpoint for the cloud KMS provider.                                                                                                                                                           |
| `FACILITATOR_KMS_KEY_ID`          | string                                       | Optional | No default                                                 | non-secret  | stellar-payments              | Cloud KMS key resource identifier used when the signer provider is kms. An identifier, not key material. Required when FACILITATOR_SIGNER_PROVIDER=kms.                                                        |
| `FACILITATOR_KMS_PROVIDER`        | string                                       | Optional | No default                                                 | non-secret  | stellar-payments              | Cloud KMS provider name used when the signer provider is kms. Required when FACILITATOR_SIGNER_PROVIDER=kms.                                                                                                   |
| `FACILITATOR_KMS_REGION`          | string                                       | Optional | No default                                                 | non-secret  | stellar-payments              | Cloud KMS region used when the signer provider is kms.                                                                                                                                                         |
| `FACILITATOR_KMS_TIMEOUT_MS`      | integer                                      | Optional | `5000`                                                     | non-secret  | stellar-payments              | Timeout in milliseconds for cloud KMS operations.                                                                                                                                                              |
| `FACILITATOR_SIGNER_NETWORK`      | enum (`stellar:testnet` \| `stellar:pubnet`) | Optional | `stellar:testnet`                                          | non-secret  | api, worker, stellar-payments | Stellar network the facilitator signer operates on: stellar:testnet or stellar:pubnet. Must match the active Stellar network when signing is enabled.                                                          |
| `FACILITATOR_SIGNER_PROVIDER`     | enum (`disabled` \| `environment` \| `kms`)  | Optional | `disabled`                                                 | non-secret  | api, worker, stellar-payments | How the facilitator signs: disabled, environment (key from the environment), or kms (cloud KMS). disabled means no signing; the signer network must match the active Stellar network when signing is enabled.  |
| `FACILITATOR_SIGNING_KEY_VERSION` | string                                       | Optional | No default                                                 | non-secret  | api, worker, stellar-payments | Version label of the facilitator signing key (secret-manager version, not the key itself). Required for hosted environment signers; the key material itself is supplied separately as FACILITATOR_SIGNING_KEY. |

## Settlement fees

| Key                                   | Type    | Required | Default | Sensitivity | Owner                 | Description                                                                                                    |
| ------------------------------------- | ------- | -------- | ------- | ----------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `STELLAR_INCLUSION_FEE_STROOPS`       | integer | Optional | `100`   | non-secret  | api, stellar-payments | Inclusion fee bid in stroops for settlement transactions. Must not exceed STELLAR_MAX_TRANSACTION_FEE_STROOPS. |
| `STELLAR_MAX_TRANSACTION_FEE_STROOPS` | integer | Optional | `50000` | non-secret  | api, stellar-payments | Maximum Stellar transaction fee in stroops for settlement transactions.                                        |

## Event streams

| Key                           | Type   | Required | Default      | Sensitivity | Owner | Description                                                                                                                                                          |
| ----------------------------- | ------ | -------- | ------------ | ----------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVENT_STREAM_SIGNING_SECRET` | string | Optional | `<redacted>` | secret      | api   | Secret used to sign event-stream payloads. When unset, signed event streams are unavailable. Supply via the hosting provider's secret manager; never commit a value. |

## Additional runtime keys (not validated by loadConfig)

| Key                          | Type         | Required    | Default                 | Sensitivity | Owner            | Description                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ------------ | ----------- | ----------------------- | ----------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_BASE_URL`               | string (URL) | Optional    | `http://localhost:3000` | non-secret  | mcp-server       | Base URL of the API used by the MCP server's backend client and by catalog scripts. Read directly from process.env in apps/mcp-server/src/client.ts.                                                                                                                                                      |
| `FACILITATOR_SIGNING_KEY`    | string       | Conditional | `<redacted>`            | secret      | stellar-payments | Secret signing key for the environment facilitator signer. Never commit a value; supply it via the hosting provider's secret manager. Read directly from process.env in packages/stellar-payments/src/facilitatorSigner.ts. Required when FACILITATOR_SIGNER_PROVIDER=environment in hosted environments. |
| `MCP_ALLOWED_ORIGINS`        | string       | Optional    | No default              | non-secret  | mcp-server       | Comma-separated list of origins allowed by MCP CORS. Absent or empty means no origin is reflected (the secure default); `*` allows every origin without credentials. Read directly from process.env in apps/mcp-server/src/http.ts.                                                                       |
| `MCP_HOST`                   | string       | Optional    | `API_HOST` (`0.0.0.0`)  | non-secret  | mcp-server       | Host interface the MCP Streamable HTTP server binds to. Falls back to API_HOST. Read directly from process.env in apps/mcp-server/src/http.ts.                                                                                                                                                            |
| `MCP_PATH`                   | string       | Optional    | `/mcp`                  | non-secret  | mcp-server       | HTTP path the MCP Streamable HTTP server serves on. Read directly from process.env in apps/mcp-server/src/http.ts.                                                                                                                                                                                        |
| `MCP_PORT`                   | integer      | Optional    | `3001`                  | non-secret  | mcp-server       | Port the MCP Streamable HTTP server listens on. Read directly from process.env in apps/mcp-server/src/http.ts.                                                                                                                                                                                            |
| `MCP_TRUST_PROXY`            | boolean      | Optional    | `false`                 | non-secret  | mcp-server       | Trust X-Forwarded-For headers for MCP rate limiting. Set to `true` only behind an ingress that replaces client forwarding headers. Read directly from process.env in apps/mcp-server/src/http.ts.                                                                                                         |
| `READINESS_PROBE_TIMEOUT_MS` | integer      | Optional    | `2000`                  | non-secret  | api              | Deadline in milliseconds for readiness probes. Read directly from process.env in apps/api/src/services/readiness.ts.                                                                                                                                                                                      |

## Out of scope

- OpenTelemetry SDK variables (`OTEL_SDK_DISABLED`, `OTEL_TRACES_SAMPLER`,
  `OTEL_TRACES_SAMPLER_ARG`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_SERVICE_NAME`) are read by
  the tracing setup in `packages/shared/src/tracing.ts` but are owned and
  documented by the OpenTelemetry SDK, not by this repository's config.
- Test-only variables (for example `PAYMENT_PERSISTENCE_TEST_DATABASE_URL`,
  `WORKER_TEST_REDIS_URL`, `CLIENT_PRIVATE_KEY`) are used by scripts and
  tests, not by the services at runtime.
- CI variables (for example `GITHUB_SHA`, `RELEASE_COMMIT`) are set by the
  CI environment, not by deployments.

## Adding a configuration key

1. Add the key to `envSchema` in `packages/shared/src/config.ts`.
2. Add a matching entry to `configKeyMetadata` in the same file (owner,
   sensitivity, section, description). The generator fails if a schema key
   has no metadata entry.
3. Add the key to `.env.example` when operators need to set it.
4. Regenerate this reference with `pnpm config:reference` and commit the
   result. If the key is read directly from `process.env` instead of the
   schema, add it to `additionalRuntimeKeys` in
   `scripts/generate-config-reference.ts` with the file that reads it.
