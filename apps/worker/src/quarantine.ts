import { type Job, type Queue } from "bullmq";

import { redactSensitiveText, type AppConfig } from "@lumenbazaar/shared";

import { type QueueName, queueNames } from "./queues.js";
import {
  type QuarantineJobData,
  QuarantineReason,
  quarantineJobDataSchema
} from "./schemas.js";
import { type PayloadValidationError } from "./validation.js";

// ============================================================================
// Quarantine Queue Management
// ============================================================================

/**
 * Create a quarantine queue for storing invalid/unknown payloads.
 * Enables observable handling of schema violations and unknown versions.
 */
export async function createQuarantineQueue(config: AppConfig) {
  // Use the existing deadLetter queue (already managed by createBullMqQueue)
  // This reuses the same queue mechanism for consistency with settlement dead-letter handling
  return null; // Quarantine jobs are sent to existing deadLetter queue
}

// ============================================================================
// Quarantine Job Handling
// ============================================================================

/**
 * Send a job to quarantine after validation failure.
 * Records the invalid payload, reason, and validation errors for investigation.
 *
 * @param deadLetterQueue - BullMQ dead-letter queue
 * @param sourceJobId - ID of the job that failed validation
 * @param sourceQueue - Queue the job came from
 * @param sourceJobName - BullMQ job name
 * @param rawPayload - Raw unvalidated payload
 * @param validationError - Validation error details
 * @param traceparent - Optional W3C trace context from job data
 */
export async function quarantineInvalidJob(
  deadLetterQueue: Queue,
  sourceJobId: string,
  sourceQueue: QueueName,
  sourceJobName: string,
  rawPayload: Record<string, unknown>,
  validationError: PayloadValidationError,
  traceparent?: string
): Promise<void> {
  const quarantineData: QuarantineJobData = {
    sourceJobId,
    sourceQueue,
    sourceJobName,
    schemaVersion: (rawPayload.schemaVersion as string | undefined),
    schemaId: (rawPayload.schemaId as string | undefined),
    rawPayload,
    reason: validationError.reason,
    validationErrors: validationError.validationErrors,
    timestamp: new Date().toISOString(),
    traceparent
  };

  // Validate the quarantine data structure
  const validated = quarantineJobDataSchema.parse(quarantineData);

  // Generate a unique job ID for the quarantine record
  const quarantineJobId = `quarantine-${sourceQueue}-${sourceJobId}-${Date.now()}`;

  // Add to dead-letter queue with long retention for manual investigation
  await deadLetterQueue.add(
    "payload-validation-quarantine",
    validated,
    {
      jobId: quarantineJobId,
      removeOnComplete: false,
      removeOnFail: false,
      // Keep quarantine records indefinitely for audit trail
      attempts: 1
    }
  );
}

// ============================================================================
// Quarantine Observation and Monitoring
// ============================================================================

/**
 * Quarantine statistics for monitoring validation failures.
 */
export interface QuarantineStats {
  totalQuarantined: number;
  byReason: Record<QuarantineReason, number>;
  bySourceQueue: Record<string, number>;
  recentQuarantines: Array<{
    jobId: string;
    reason: QuarantineReason;
    sourceQueue: QueueName;
    timestamp: string;
  }>;
}

/**
 * Handler for processing quarantine records.
 * Can be used for observability, alerting, or automated recovery.
 *
 * @param job - Quarantine job from dead-letter queue
 */
export async function handleQuarantineJob(
  job: Job<Record<string, unknown>>
): Promise<void> {
  // Parse the quarantine data
  let quarantineData: QuarantineJobData;

  try {
    quarantineData = quarantineJobDataSchema.parse(job.data);
  } catch (error) {
    // If we can't even parse the quarantine record, log it
    await job.log(
      `Failed to parse quarantine record: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }

  // Log the quarantine event with redaction for sensitive data
  const redactedPayload = redactSensitiveText(JSON.stringify(quarantineData.rawPayload));
  await job.log(
    `Quarantined job ${quarantineData.sourceJobId} from queue ${quarantineData.sourceQueue} ` +
    `(reason: ${quarantineData.reason}). Payload: ${redactedPayload.slice(0, 500)}`
  );

  // Record validation errors if present
  if (quarantineData.validationErrors && quarantineData.validationErrors.length > 0) {
    const errorSummary = quarantineData.validationErrors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    await job.log(`Validation errors: ${errorSummary}`);
  }

  // In production, this handler could:
  // 1. Send alerts to monitoring/observability systems
  // 2. Record metrics for SLO tracking
  // 3. Trigger automated recovery for transient issues
  // 4. Create support tickets for investigation
  // For now, we just log and preserve the record
}

// ============================================================================
// Reason-Specific Handlers
// ============================================================================

/**
 * Handle jobs with unknown schema IDs.
 * Suggests that either:
 * 1. A new job type was enqueued but handlers haven't been deployed
 * 2. The job is from an older version that used different schema IDs
 * 3. Payload is corrupted
 *
 * @param quarantine - Quarantine job data
 */
export function analyzeUnknownSchemaId(quarantine: QuarantineJobData): {
  severity: "error" | "warning";
  recommendation: string;
} {
  return {
    severity: "error",
    recommendation: `Unknown schema ID "${quarantine.schemaId}". This job cannot be processed. ` +
      `Check if the job type definition is missing or if this is a payload from a newer API version. ` +
      `Payload must be manually reviewed and either deleted or migrated to a known schema ID.`
  };
}

/**
 * Handle jobs with unknown schema versions.
 * Suggests version compatibility issues.
 *
 * @param quarantine - Quarantine job data
 */
export function analyzeUnknownSchemaVersion(quarantine: QuarantineJobData): {
  severity: "error" | "warning";
  recommendation: string;
} {
  return {
    severity: "error",
    recommendation: `Unknown schema version "${quarantine.schemaVersion}" for schema ID "${quarantine.schemaId}". ` +
      `This indicates a version mismatch between the producer and consumer. ` +
      `The envelope was created by a newer version of the API than this worker supports. ` +
      `Consider updating the worker or implementing a migration handler for this version.`
  };
}

/**
 * Handle jobs that failed schema validation.
 * Suggests the payload structure doesn't match the schema.
 *
 * @param quarantine - Quarantine job data
 */
export function analyzeSchemaValidationFailure(quarantine: QuarantineJobData): {
  severity: "error" | "warning";
  recommendation: string;
} {
  const errors = (quarantine.validationErrors ?? [])
    .map((e) => `${e.path.join(".")}: ${e.message}`)
    .slice(0, 3)
    .join("; ");

  return {
    severity: "error",
    recommendation: `Schema validation failed for schema ID "${quarantine.schemaId}". ` +
      `Validation errors: ${errors}${(quarantine.validationErrors?.length ?? 0) > 3 ? "..." : ""}. ` +
      `This indicates the payload structure is incorrect or missing required fields. ` +
      `Review the schema definition and the code that enqueued this job.`
  };
}

/**
 * Handle jobs with malformed envelopes.
 * Suggests the job data is corrupted or from an incompatible source.
 *
 * @param quarantine - Quarantine job data
 */
export function analyzeMalformedEnvelope(quarantine: QuarantineJobData): {
  severity: "error" | "warning";
  recommendation: string;
} {
  return {
    severity: "error",
    recommendation: `Job envelope is malformed. Expected fields (schemaVersion, schemaId, payload) are missing or have wrong types. ` +
      `This suggests the job was not created by a standard enqueue function or the queue data was corrupted. ` +
      `Check the queue backing store (Redis) for corruption and review enqueue code for bugs.`
  };
}

// ============================================================================
// Quarantine Diagnostics
// ============================================================================

/**
 * Get diagnostic information about a quarantine record.
 * Helps operators understand why a job was quarantined and what to do about it.
 *
 * @param quarantine - Quarantine job data
 * @returns Diagnostic information
 */
export function diagnoseQuarantine(quarantine: QuarantineJobData): {
  severity: "error" | "warning";
  reason: string;
  recommendation: string;
  recoveryOptions: string[];
} {
  let diagnosis: ReturnType<typeof analyzeUnknownSchemaId>;

  switch (quarantine.reason) {
    case QuarantineReason.UNKNOWN_SCHEMA_ID:
      diagnosis = analyzeUnknownSchemaId(quarantine);
      break;
    case QuarantineReason.UNKNOWN_SCHEMA_VERSION:
      diagnosis = analyzeUnknownSchemaVersion(quarantine);
      break;
    case QuarantineReason.SCHEMA_VALIDATION_FAILED:
      diagnosis = analyzeSchemaValidationFailure(quarantine);
      break;
    case QuarantineReason.MALFORMED_ENVELOPE:
      diagnosis = analyzeMalformedEnvelope(quarantine);
      break;
    case QuarantineReason.MISSING_PAYLOAD:
      diagnosis = {
        severity: "error",
        recommendation: "The payload field is missing from the job envelope. " +
          "This is a critical error in the enqueue logic."
      };
      break;
    default:
      const _exhaustive: never = quarantine.reason;
      diagnosis = {
        severity: "error",
        recommendation: "Unknown quarantine reason: " + String(quarantine.reason)
      };
  }

  const recoveryOptions: string[] = [];

  // Always offer deletion as an option
  recoveryOptions.push("Delete the quarantine record after investigation");

  // Suggest recovery based on reason
  if (quarantine.reason === QuarantineReason.UNKNOWN_SCHEMA_VERSION) {
    recoveryOptions.push(
      "Deploy worker code that supports the newer schema version",
      "Manually migrate the payload to the current schema version"
    );
  }

  if (quarantine.reason === QuarantineReason.SCHEMA_VALIDATION_FAILED) {
    recoveryOptions.push(
      "Fix the enqueue code to generate valid payloads",
      "Manually correct the payload fields to match the schema"
    );
  }

  return {
    severity: diagnosis.severity,
    reason: quarantine.reason,
    recommendation: diagnosis.recommendation,
    recoveryOptions
  };
}
