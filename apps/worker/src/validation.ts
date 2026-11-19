import { z } from "zod";

import {
  JOB_SCHEMA_VERSION,
  jobEnvelopeSchema,
  schemaRegistry,
  QuarantineReason,
  type SchemaId,
  type PayloadBySchemaId,
  type QuarantineJobData
} from "./schemas.js";

// ============================================================================
// Validation Error Types
// ============================================================================

/**
 * Validation error with structured information.
 * Includes the reason why validation failed and optional Zod errors.
 */
export interface PayloadValidationError {
  reason: QuarantineReason;
  message: string;
  validationErrors?: Array<{
    path: (string | number)[];
    message: string;
  }>;
}

/**
 * Result type for validation operations.
 * Either contains a valid payload or a validation error.
 */
export type ValidationResult<T> =
  | { success: true; payload: T; envelope: Record<string, unknown> }
  | { success: false; error: PayloadValidationError };

// ============================================================================
// Version Comparison
// ============================================================================

/**
 * Parse a semantic version string into components.
 * Returns null if the version string is invalid.
 *
 * @param version - Semantic version string (e.g., "1.2.3")
 * @returns Object with major, minor, patch fields or null
 */
export function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  };
}

/**
 * Check if an envelope version is compatible with the current job schema version.
 *
 * Compatibility rules:
 * - Same MAJOR version: compatible (minor/patch differences are ok)
 * - Different MAJOR version: incompatible (breaking change)
 *
 * @param envelopeVersion - Version from job envelope
 * @returns true if compatible, false if incompatible
 */
export function isVersionCompatible(envelopeVersion: string): boolean {
  const current = parseVersion(JOB_SCHEMA_VERSION);
  const envelope = parseVersion(envelopeVersion);

  if (!current || !envelope) {
    return false;
  }

  // Same major version = compatible
  return current.major === envelope.major;
}

// ============================================================================
// Envelope Validation
// ============================================================================

/**
 * Validate the job envelope structure.
 * Checks that required fields exist and have correct types.
 *
 * @param data - Raw job data from queue
 * @returns Validation result
 */
export function validateEnvelope(data: unknown): ValidationResult<Record<string, unknown>> {
  try {
    const envelope = jobEnvelopeSchema.parse(data);
    return { success: true, payload: envelope, envelope };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: {
          reason: QuarantineReason.MALFORMED_ENVELOPE,
          message: `Invalid job envelope structure: ${error.message}`,
          validationErrors: error.errors.map((e) => ({
            path: e.path,
            message: e.message
          }))
        }
      };
    }
    return {
      success: false,
      error: {
        reason: QuarantineReason.MALFORMED_ENVELOPE,
        message: `Unexpected error validating envelope: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }
}

// ============================================================================
// Payload Validation
// ============================================================================

/**
 * Validate a job payload against its schema.
 * Performs type validation, field presence checks, and enum validation.
 *
 * @param schemaId - Unique identifier for job type
 * @param payload - Raw payload to validate
 * @returns Validation result
 */
export function validatePayload<T extends SchemaId>(
  schemaId: T,
  payload: unknown
): ValidationResult<PayloadBySchemaId[T]> {
  const schemaVersionEntry = schemaRegistry[schemaId];
  if (!schemaVersionEntry) {
    return {
      success: false,
      error: {
        reason: QuarantineReason.UNKNOWN_SCHEMA_ID,
        message: `Unknown schema ID: ${schemaId}`
      }
    };
  }

  // Always use v1 schema for now (future: support multiple versions)
  const schema = schemaVersionEntry.v1;
  if (!schema) {
    return {
      success: false,
      error: {
        reason: QuarantineReason.UNKNOWN_SCHEMA_VERSION,
        message: `No schema found for ${schemaId} v1`
      }
    };
  }

  try {
    const validated = schema.parse(payload);
    return {
      success: true,
      payload: validated as PayloadBySchemaId[T],
      envelope: { schemaId, payload: validated }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: {
          reason: QuarantineReason.SCHEMA_VALIDATION_FAILED,
          message: `Payload validation failed for schema ${schemaId}: ${error.message}`,
          validationErrors: error.errors.map((e) => ({
            path: e.path,
            message: e.message
          }))
        }
      };
    }
    return {
      success: false,
      error: {
        reason: QuarantineReason.SCHEMA_VALIDATION_FAILED,
        message: `Unexpected error validating payload: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }
}

// ============================================================================
// Full Envelope Validation (Enqueue)
// ============================================================================

/**
 * Validate a complete job envelope with payload.
 * Used at enqueue time to catch malformed payloads early.
 *
 * @param data - Raw job data
 * @returns Validation result with envelope and validated payload
 */
export function validateJobEnvelope(data: unknown): ValidationResult<Record<string, unknown>> {
  // First, validate envelope structure
  const envelopeResult = validateEnvelope(data);
  if (!envelopeResult.success) {
    return envelopeResult;
  }

  const envelope = envelopeResult.payload;
  const schemaId = envelope.schemaId as string;
  const schemaVersion = envelope.schemaVersion as string;

  // Check version compatibility
  if (!isVersionCompatible(schemaVersion)) {
    return {
      success: false,
      error: {
        reason: QuarantineReason.UNKNOWN_SCHEMA_VERSION,
        message: `Incompatible schema version ${schemaVersion}; current version is ${JOB_SCHEMA_VERSION}`
      }
    };
  }

  // Validate payload against schema
  const payloadResult = validatePayload(schemaId as SchemaId, envelope.payload);
  if (!payloadResult.success) {
    return payloadResult;
  }

  return envelopeResult;
}

// ============================================================================
// Envelope Creation (Enqueue)
// ============================================================================

/**
 * Create a versioned envelope for a job payload.
 * Wraps the payload with version information for validation at dequeue time.
 *
 * @param schemaId - Unique identifier for job type
 * @param payload - Job payload to wrap
 * @param traceparent - Optional W3C trace context
 * @returns Complete envelope ready for enqueue
 */
export function createJobEnvelope<T extends SchemaId>(
  schemaId: T,
  payload: PayloadBySchemaId[T],
  traceparent?: string
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    schemaVersion: JOB_SCHEMA_VERSION,
    schemaId,
    payload
  };

  if (traceparent) {
    envelope.traceparent = traceparent;
  }

  return envelope;
}

// ============================================================================
// Quarantine Job Creation
// ============================================================================

/**
 * Create a quarantine job record from a failed validation.
 * Used to record why a job couldn't be processed.
 *
 * @param sourceJobId - ID of the job that failed validation
 * @param sourceQueue - Queue the job came from
 * @param sourceJobName - BullMQ job name
 * @param rawPayload - Raw unvalidated payload
 * @param error - Validation error
 * @param traceparent - Optional W3C trace context
 * @returns Quarantine job data
 */
export function createQuarantineJob(
  sourceJobId: string,
  sourceQueue: string,
  sourceJobName: string,
  rawPayload: Record<string, unknown>,
  error: PayloadValidationError,
  traceparent?: string
): QuarantineJobData {
  return {
    sourceJobId,
    sourceQueue,
    sourceJobName,
    schemaVersion: rawPayload.schemaVersion as string | undefined,
    schemaId: rawPayload.schemaId as string | undefined,
    rawPayload,
    reason: error.reason,
    validationErrors: error.validationErrors,
    timestamp: new Date().toISOString(),
    traceparent
  };
}

// ============================================================================
// Batch Validation (for testing)
// ============================================================================

/**
 * Validate multiple payloads at once.
 * Returns array of validation results in the same order.
 *
 * @param items - Array of raw payloads to validate
 * @returns Array of validation results
 */
export function validateBatch(
  items: Array<{ schemaId: SchemaId; payload: unknown }>
): Array<ValidationResult<Record<string, unknown>>> {
  return items.map(({ schemaId, payload }) =>
    validatePayload(schemaId, payload) as ValidationResult<Record<string, unknown>>
  );
}
