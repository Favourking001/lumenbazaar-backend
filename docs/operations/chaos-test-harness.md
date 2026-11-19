# Dependency Outage Chaos-Test Harness

Recovery behavior for database, Redis, Horizon RPC, and facilitator outages
was previously tested piecemeal rather than as coordinated incidents. This
harness injects dependency failures as deterministic scenarios and verifies
state recovery — no duplicate settlement, no lost job — with a structured
failure timeline and recovery evidence report.

Related runbook: `docs/operations/payment-incidents.md` (dependency outage
and stuck settlement sections). The harness is a test tool; it never changes
production behavior and never contacts a live service.

## Safety guarantees

- **Opt-in only.** The runner refuses to run unless the operator passes
  `--opt-in` (or sets `CHAOS_HARNESS_OPT_IN=1`).
- **Never targets production endpoints.** Every endpoint the harness accepts
  is validated by `assertTestEndpoint`, which allows only loopback hosts
  (`localhost`, `127.0.0.1`, `::1`) and the public Stellar testnet hosts
  (`horizon-testnet.stellar.org`, `soroban-testnet.stellar.org`). Stellar
  pubnet (`horizon.stellar.org`, `mainnet.sorobanrpc.com`) and every other
  host are refused, as are non-HTTP(S) schemes, URLs with embedded
  credentials, and unparseable strings. The guard fails closed: an invalid
  endpoint throws `ChaosGuardError` before anything runs.
- **Synthetic data only.** Scenarios use synthetic job and payment-attempt
  ids (`chaos_job_*`, `chaos_attempt_*`). Never pass secrets, seed phrases,
  private keys, signed private payloads, or production records to the
  harness. Unsupported network and payment capabilities stay fail closed
  and accurately labeled — the harness does not simulate them as working.

## Determinism

Scenarios are seeded. Timelines use a virtual clock (logical ticks, not
wall-clock time) and a seeded PRNG, so running the same scenario with the
same seed always produces the identical report. Verify with:

```bash
pnpm chaos -- --opt-in --scenario database-outage-during-settlement --output /tmp/a.json
pnpm chaos -- --opt-in --scenario database-outage-during-settlement --output /tmp/b.json
diff /tmp/a.json /tmp/b.json # no differences
```

## Running scenarios

```bash
# All built-in scenarios (in-memory fakes only; no live service is contacted)
pnpm chaos -- --opt-in

# One scenario, with a JSON report
pnpm chaos -- --opt-in --scenario combined-outage --output chaos-evidence/combined.json

# Override the seed (same scenario, different deterministic run)
pnpm chaos -- --opt-in --scenario redis-outage-job-queue --seed my-seed-1

# Bind dependency endpoints (validated by the guard; still never contacted)
pnpm chaos -- --opt-in --endpoint database=http://localhost:5432 \
  --endpoint horizon=https://horizon-testnet.stellar.org
```

Exit code is `0` when every scenario passes all assertions, `1` otherwise.

## Built-in scenarios

| Scenario                            | Outage                                            |
| ----------------------------------- | ------------------------------------------------- |
| `database-outage-during-settlement` | Database down ticks 1–3                           |
| `redis-outage-job-queue`            | Redis down ticks 1–4                              |
| `horizon-outage-reconciliation`     | Horizon RPC down ticks 1–3                        |
| `facilitator-outage-settle`         | Facilitator down ticks 1–2                        |
| `combined-outage`                   | All four down in sequence, recovering in sequence |

Each scenario submits 3 jobs and settles 2 payment attempts. While a
dependency is down, the affected work is deferred and recorded, then
retried after recovery; once every dependency is back up, pending work is
drained.

## Assertions

Every scenario run asserts:

- `no-duplicate-settlement` — settlement ids recorded are all unique.
- `no-lost-job` — every submitted job is accounted for (completed or
  pending).
- `all-jobs-completed-after-recovery` — no job is still pending after the
  drain.
- `all-settlements-recorded` — every payment attempt has exactly one
  settlement.
- `dependencies-recovered` — no dependency is still down at the end.
- `all-jobs-submitted` — every job was submitted.

## Report format

`runChaosScenario` returns a `ChaosReport`:

```json
{
  "scenarioId": "database-outage-during-settlement",
  "seed": "chaos-database-1",
  "runId": "chaos_database-outage-during-settlement_chaos-database-1",
  "deterministic": true,
  "startedAt": "1970-01-01T00:00:00.123Z",
  "completedAt": "1970-01-01T00:00:05.123Z",
  "timeline": [
    { "tick": 1, "timestamp": "...", "type": "dependency-failed", "dependency": "database" },
    {
      "tick": 1,
      "timestamp": "...",
      "type": "job-deferred",
      "dependency": "database",
      "jobId": "chaos_job_1"
    },
    { "tick": 3, "timestamp": "...", "type": "dependency-recovered", "dependency": "database" }
  ],
  "assertions": [{ "id": "no-duplicate-settlement", "passed": true, "detail": "..." }],
  "recoveryEvidence": {
    "jobsSubmitted": 3,
    "jobsCompleted": 3,
    "jobsRecovered": 3,
    "settlementsConfirmed": 2,
    "ticksToRecover": 2,
    "dependenciesRecovered": ["database"]
  },
  "passed": true
}
```

The timeline is the failure timeline: every injected failure, every
deferred operation, every recovery, and the drain. The recovery evidence
summarizes what came back and how long recovery took (in ticks).

## Using the harness in code

`packages/testkit/src/chaos.ts` exports the harness; it is also re-exported
from `@lumenbazaar/testkit`:

```ts
import { InMemoryChaosSystem, runChaosScenario, getChaosScenario } from "@lumenbazaar/testkit";

const definition = getChaosScenario("combined-outage");
const report = await runChaosScenario(definition, new InMemoryChaosSystem());
```

To run a scenario against a real system instead of the in-memory fake,
implement `ChaosSystemUnderTest` (`submitJob`, `settlePayment`, `drain`,
`snapshot`). The implementation must be idempotent — submitting the same
job twice or settling the same attempt twice must not create a second job
or a second settlement — because that is exactly what the harness asserts.
The worker's settlement-confirmation path (`apps/worker/src/workers/
settlementConfirmation.ts`) already treats already-final settlements as
harmless and uses the stable reconciliation job id, and the outbox relay
is idempotent by design; a `ChaosSystemUnderTest` adapter over those
paths is the intended integration point. Keep the adapter in test code:
the harness itself must never be wired into the production worker loop.

Custom scenarios are plain `ChaosScenarioDefinition` objects validated by
`validateChaosScenario` (duplicate ids, unsorted ticks, and contradictory
fail/recover transitions are rejected before the run starts).
