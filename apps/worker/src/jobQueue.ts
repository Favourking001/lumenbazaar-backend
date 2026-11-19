import { type Queue } from "bullmq";

import { getTraceparent, type AppConfig, createJobEnvelope, schemaIds } from "@lumenbazaar/shared";
import { settlementReconciliationJobId } from "@lumenbazaar/stellar-payments";

import { createBullMqQueue, queueNames } from "./queues.js";
import { type SettlementConfirmationJobData } from "./workers/settlementConfirmation.js";
import { type ResourceIndexingJobData } from "./workers/resourceIndexing.js";
import { type SearchSyncJobData } from "./workers/searchSync.js";
import { type NetworkHealthJobData } from "./workers/networkHealth.js";
import { type ReceiptFinalizerJobData } from "./workers/receiptFinalizer.js";
import { type StalePaymentCleanupJobData } from "./workers/stalePaymentCleanup.js";
import { type WebhookDeliveryJobInput } from "./workers/webhookDelivery.js";

function createEnvelopeWithTraceparent<T extends { schemaId?: string; schemaVersion?: string }>(
  payload: T,
  schemaId: string
): Record<string, unknown> {
  const traceparent = getTraceparent();
  const envelope = createJobEnvelope(schemaId as any, payload as any, traceparent);
  return envelope;
}

export type JobQueues = {
  settlementConfirmation: Queue;
  resourceIndexing: Queue;
  searchSync: Queue;
  conformanceRunner: Queue;
  networkHealth: Queue;
  receiptFinalizer: Queue;
  stalePaymentCleanup: Queue;
  webhookDelivery: Queue;
  deadLetter: Queue;
};

export function createJobQueues(config: AppConfig): JobQueues {
  return {
    settlementConfirmation: createBullMqQueue(queueNames.settlementConfirmation, config),
    resourceIndexing: createBullMqQueue(queueNames.resourceIndexing, config),
    searchSync: createBullMqQueue(queueNames.searchSync, config),
    conformanceRunner: createBullMqQueue(queueNames.conformanceRunner, config),
    networkHealth: createBullMqQueue(queueNames.networkHealth, config),
    receiptFinalizer: createBullMqQueue(queueNames.receiptFinalizer, config),
    stalePaymentCleanup: createBullMqQueue(queueNames.stalePaymentCleanup, config),
    webhookDelivery: createBullMqQueue(queueNames.webhookDelivery, config),
    deadLetter: createBullMqQueue(queueNames.deadLetter, config)
  };
}

export async function enqueueSettlementConfirmation(
  queue: Queue,
  data: SettlementConfirmationJobData,
  { delayMs = 5000, maxAttempts = 8 } = {}
) {
  const envelope = createEnvelopeWithTraceparent(data, schemaIds.settlementConfirmation);
  return queue.add("settlement-confirmation", envelope, {
    jobId: settlementReconciliationJobId(data.paymentAttemptId),
    delay: delayMs,
    attempts: maxAttempts,
    backoff: {
      type: "exponential",
      delay: delayMs
    },
    removeOnComplete: 1000,
    removeOnFail: false
  });
}

export async function enqueueResourceIndexing(
  queue: Queue,
  data: ResourceIndexingJobData,
  { delayMs = 1000, maxAttempts = 5 } = {}
) {
  const envelope = createEnvelopeWithTraceparent(data, schemaIds.resourceIndexing);
  return queue.add("resource-indexing", envelope, {
    attempts: maxAttempts,
    backoff: {
      type: "exponential",
      delay: delayMs
    },
    removeOnComplete: true,
    removeOnFail: false
  });
}

export async function enqueueSearchSync(
  queue: Queue,
  data: SearchSyncJobData,
  { delayMs = 1000, maxAttempts = 3 } = {}
) {
  const envelope = createEnvelopeWithTraceparent(data, schemaIds.searchSync);
  return queue.add("search-sync", envelope, {
    attempts: maxAttempts,
    backoff: {
      type: "exponential",
      delay: delayMs
    },
    removeOnComplete: true,
    removeOnFail: false
  });
}

export async function enqueueNetworkHealth(
  queue: Queue,
  data: NetworkHealthJobData,
  { delayMs = 30000, maxAttempts = 3 } = {}
) {
  const envelope = createEnvelopeWithTraceparent(data, schemaIds.networkHealth);
  return queue.add("network-health", envelope, {
    attempts: maxAttempts,
    backoff: {
      type: "exponential",
      delay: delayMs
    },
    removeOnComplete: true,
    removeOnFail: false
  });
}

export async function enqueueReceiptFinalizer(
  queue: Queue,
  data: ReceiptFinalizerJobData,
  { delayMs = 10000, maxAttempts = 3 } = {}
) {
  const envelope = createEnvelopeWithTraceparent(data, schemaIds.receiptFinalizer);
  return queue.add("receipt-finalizer", envelope, {
    attempts: maxAttempts,
    backoff: {
      type: "exponential",
      delay: delayMs
    },
    removeOnComplete: true,
    removeOnFail: false
  });
}

export async function enqueueStalePaymentCleanup(
  queue: Queue,
  data: StalePaymentCleanupJobData,
  { delayMs = 60000, maxAttempts = 2 } = {}
) {
  const envelope = createEnvelopeWithTraceparent(data, schemaIds.stalePaymentCleanup);
  return queue.add("stale-payment-cleanup", envelope, {
    attempts: maxAttempts,
    backoff: {
      type: "exponential",
      delay: delayMs
    },
    removeOnComplete: true,
    removeOnFail: false
  });
}

export async function enqueueWebhookDelivery(
  queue: Queue,
  data: WebhookDeliveryJobInput,
  { delayMs = 0, maxAttempts = 5 } = {}
) {
  // Use stable job ID based on eventId + endpointId for idempotency
  const jobId = `${data.eventId}:${data.endpointId}:attempt-${data.attemptNumber}`;

  const envelope = createEnvelopeWithTraceparent(data, schemaIds.webhookDelivery);
  return queue.add("webhook-delivery", envelope, {
    jobId,
    delay: delayMs,
    attempts: 1, // Single attempt per job; retries are queued as new jobs
    backoff: {
      type: "exponential",
      delay: delayMs
    },
    removeOnComplete: 1000, // Keep completed jobs for audit
    removeOnFail: false
  });
}
