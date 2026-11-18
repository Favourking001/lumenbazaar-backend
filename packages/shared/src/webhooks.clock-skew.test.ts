import { describe, expect, it } from "vitest";
import {
  computeWebhookSignature,
  verifyWebhookSignature,
  type WebhookSignatureVerificationResult
} from "./webhooks.js";
import { type Clock } from "./webhooks.js";

/**
 * Test fixtures for clock-skew verification matrix.
 * Synthetic/testnet data only, no real secrets.
 */

const TEST_SECRET = "test-webhook-secret";
const TEST_BODY = '{"eventId":"evt_123","status":"confirmed"}';
const TEST_REPLAY_WINDOW_SECONDS = 300; // 5 minutes

/**
 * Create a clock fixed to a specific time.
 * Used for deterministic test scenarios.
 */
function createFixedClock(absoluteTimeMs: number): Clock {
  return {
    now(): number {
      return absoluteTimeMs;
    }
  };
}

/**
 * Create an ISO 8601 timestamp string from milliseconds.
 */
function timestampFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

describe("Webhook Signature Clock-Skew Verification Matrix", () => {
  const baseTime = 1_000_000_000_000; // Fixed reference time (2001-09-09)
  const baseClock = createFixedClock(baseTime);
  const baseTimestamp = timestampFromMs(baseTime);
  const baseSignature = computeWebhookSignature(TEST_SECRET, baseTimestamp, TEST_BODY);

  describe("Zero Clock Skew", () => {
    it("accepts a valid signature with zero skew", () => {
      const result = verifyWebhookSignature(
        TEST_SECRET,
        baseTimestamp,
        TEST_BODY,
        baseSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toEqual({ valid: true });
    });
  });

  describe("Boundary Tests: At Window Edge", () => {
    it("accepts a signature at exactly the replay window boundary (300s)", () => {
      const oldTimestamp = timestampFromMs(baseTime - 300_000); // Exactly 300s old
      const oldSignature = computeWebhookSignature(TEST_SECRET, oldTimestamp, TEST_BODY);
      const clockNow = baseClock;

      const result = verifyWebhookSignature(
        TEST_SECRET,
        oldTimestamp,
        TEST_BODY,
        oldSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        clockNow
      );

      expect(result).toEqual({ valid: true });
    });

    it("rejects a signature just beyond the replay window (301s), marked as stale", () => {
      const tooOldTimestamp = timestampFromMs(baseTime - 301_000); // 301s old
      const tooOldSignature = computeWebhookSignature(TEST_SECRET, tooOldTimestamp, TEST_BODY);
      const clockNow = baseClock;

      const result = verifyWebhookSignature(
        TEST_SECRET,
        tooOldTimestamp,
        TEST_BODY,
        tooOldSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        clockNow
      ) as WebhookSignatureVerificationResult;

      expect(result.valid).toBe(false);
      expect(result.errorType).toBe("stale");
      expect(result.reason).toContain("older than replay window");
    });
  });

  describe("Stale Timestamp Tests", () => {
    it("rejects a signature 1 second past the window, marked as stale", () => {
      const staleTimestamp = timestampFromMs(baseTime - 301_000);
      const staleSignature = computeWebhookSignature(TEST_SECRET, staleTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        staleTimestamp,
        TEST_BODY,
        staleSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "stale"
      });
    });

    it("rejects a signature 1 hour old, marked as stale", () => {
      const veryOldTimestamp = timestampFromMs(baseTime - 3_600_000); // 1 hour
      const veryOldSignature = computeWebhookSignature(TEST_SECRET, veryOldTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        veryOldTimestamp,
        TEST_BODY,
        veryOldSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "stale"
      });
    });

    it("rejects a signature from 1 week ago, marked as stale", () => {
      const ancientTimestamp = timestampFromMs(baseTime - 7 * 24 * 3600 * 1000);
      const ancientSignature = computeWebhookSignature(TEST_SECRET, ancientTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        ancientTimestamp,
        TEST_BODY,
        ancientSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "stale"
      });
    });
  });

  describe("Future Timestamp Tests", () => {
    it("rejects a signature 1 second in the future, marked as future", () => {
      const futureTimestamp = timestampFromMs(baseTime + 1_000);
      const futureSignature = computeWebhookSignature(TEST_SECRET, futureTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        futureTimestamp,
        TEST_BODY,
        futureSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "future",
        reason: /in the future/i
      });
    });

    it("rejects a signature 5 minutes in the future, marked as future", () => {
      const farFutureTimestamp = timestampFromMs(baseTime + 300_000);
      const farFutureSignature = computeWebhookSignature(
        TEST_SECRET,
        farFutureTimestamp,
        TEST_BODY
      );

      const result = verifyWebhookSignature(
        TEST_SECRET,
        farFutureTimestamp,
        TEST_BODY,
        farFutureSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "future"
      });
    });

    it("rejects a signature 1 hour in the future, marked as future", () => {
      const wayFutureTimestamp = timestampFromMs(baseTime + 3_600_000);
      const wayFutureSignature = computeWebhookSignature(
        TEST_SECRET,
        wayFutureTimestamp,
        TEST_BODY
      );

      const result = verifyWebhookSignature(
        TEST_SECRET,
        wayFutureTimestamp,
        TEST_BODY,
        wayFutureSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "future"
      });
    });
  });

  describe("Indeterminate Error Tests (Fail-Closed)", () => {
    it("rejects invalid ISO 8601 timestamp, marked as indeterminate", () => {
      const result = verifyWebhookSignature(
        TEST_SECRET,
        "not-a-valid-timestamp",
        TEST_BODY,
        baseSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "indeterminate",
        reason: /not valid ISO 8601/i
      });
    });

    it("rejects non-numeric ISO 8601 timestamp, marked as indeterminate", () => {
      const result = verifyWebhookSignature(
        TEST_SECRET,
        "2024-13-45T99:99:99.999Z", // Invalid month, day, hours
        TEST_BODY,
        baseSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "indeterminate"
      });
    });

    it("rejects malformed timestamp (empty string), marked as indeterminate", () => {
      const result = verifyWebhookSignature(
        TEST_SECRET,
        "",
        TEST_BODY,
        baseSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "indeterminate"
      });
    });

    it("rejects signature in wrong format (not hex), marked as indeterminate", () => {
      const result = verifyWebhookSignature(
        TEST_SECRET,
        baseTimestamp,
        TEST_BODY,
        "not-hex-encoded!",
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "indeterminate",
        reason: /invalid|format/i
      });
    });

    it("rejects signature with wrong odd-length hex, marked as indeterminate", () => {
      const result = verifyWebhookSignature(
        TEST_SECRET,
        baseTimestamp,
        TEST_BODY,
        "abcde", // 5 hex chars (odd)
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "indeterminate"
      });
    });

    it("rejects signature with mismatched value, marked as indeterminate", () => {
      // Compute correct signature, then flip bits
      const correctSig = computeWebhookSignature(TEST_SECRET, baseTimestamp, TEST_BODY);
      const wrongSig = correctSig.split("").reverse().join(""); // Reverse hex string

      const result = verifyWebhookSignature(
        TEST_SECRET,
        baseTimestamp,
        TEST_BODY,
        wrongSig,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "indeterminate",
        reason: /mismatch/i
      });
    });

    it("rejects body with tampered content, marked as indeterminate", () => {
      const result = verifyWebhookSignature(
        TEST_SECRET,
        baseTimestamp,
        '{"eventId":"evt_123","status":"wrong"}', // Tampered body
        baseSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "indeterminate",
        reason: /mismatch/i
      });
    });

    it("rejects signature computed with wrong secret, marked as indeterminate", () => {
      const wrongSecret = "different-secret";
      const wrongSig = computeWebhookSignature(wrongSecret, baseTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET, // Different secret
        baseTimestamp,
        TEST_BODY,
        wrongSig,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "indeterminate"
      });
    });
  });

  describe("Clock Injection: Producer vs Consumer Skew", () => {
    it("handles producer 10s slow (clock behind), signature accepted", () => {
      // Producer clock is 10s behind, so it sends timestamp that appears recent
      const producerTime = baseTime - 10_000;
      const producerTimestamp = timestampFromMs(producerTime);
      const producerSignature = computeWebhookSignature(
        TEST_SECRET,
        producerTimestamp,
        TEST_BODY
      );

      // Consumer clock is at baseTime (10s ahead)
      const consumerClock = baseClock;

      const result = verifyWebhookSignature(
        TEST_SECRET,
        producerTimestamp,
        TEST_BODY,
        producerSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        consumerClock
      );

      expect(result.valid).toBe(true);
    });

    it("handles consumer 10s slow (clock behind), signature still accepted", () => {
      // Producer clock is at baseTime
      const producerTimestamp = baseTimestamp;
      const producerSignature = computeWebhookSignature(
        TEST_SECRET,
        producerTimestamp,
        TEST_BODY
      );

      // Consumer clock is 10s behind, so timestamp appears more recent
      const consumerTime = baseTime - 10_000;
      const consumerClock = createFixedClock(consumerTime);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        producerTimestamp,
        TEST_BODY,
        producerSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        consumerClock
      );

      expect(result.valid).toBe(true);
    });

    it("handles producer 310s slow (exceeds window), rejected as stale", () => {
      // Producer clock is 310s behind
      const producerTime = baseTime - 310_000;
      const producerTimestamp = timestampFromMs(producerTime);
      const producerSignature = computeWebhookSignature(
        TEST_SECRET,
        producerTimestamp,
        TEST_BODY
      );

      // Consumer clock is at baseTime
      const consumerClock = baseClock;

      const result = verifyWebhookSignature(
        TEST_SECRET,
        producerTimestamp,
        TEST_BODY,
        producerSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        consumerClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "stale"
      });
    });

    it("handles consumer 310s slow (producer ahead), rejected as future", () => {
      // Producer clock is ahead
      const producerTime = baseTime + 310_000;
      const producerTimestamp = timestampFromMs(producerTime);
      const producerSignature = computeWebhookSignature(
        TEST_SECRET,
        producerTimestamp,
        TEST_BODY
      );

      // Consumer clock is 310s behind the producer
      const consumerClock = baseClock;

      const result = verifyWebhookSignature(
        TEST_SECRET,
        producerTimestamp,
        TEST_BODY,
        producerSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        consumerClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "future"
      });
    });
  });

  describe("Custom Replay Windows", () => {
    it("accepts timestamp within custom 60s window", () => {
      const timeWindow = 60;
      const oldTimestamp = timestampFromMs(baseTime - 60_000);
      const oldSignature = computeWebhookSignature(TEST_SECRET, oldTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        oldTimestamp,
        TEST_BODY,
        oldSignature,
        timeWindow,
        baseClock
      );

      expect(result.valid).toBe(true);
    });

    it("rejects timestamp 61s old with 60s window, marked as stale", () => {
      const timeWindow = 60;
      const tooOldTimestamp = timestampFromMs(baseTime - 61_000);
      const tooOldSignature = computeWebhookSignature(TEST_SECRET, tooOldTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        tooOldTimestamp,
        TEST_BODY,
        tooOldSignature,
        timeWindow,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "stale"
      });
    });

    it("accepts very recent timestamp within 1s window", () => {
      const timeWindow = 1;
      const recentTimestamp = timestampFromMs(baseTime - 500);
      const recentSignature = computeWebhookSignature(TEST_SECRET, recentTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        recentTimestamp,
        TEST_BODY,
        recentSignature,
        timeWindow,
        baseClock
      );

      expect(result.valid).toBe(true);
    });

    it("rejects 1.5s old timestamp with 1s window, marked as stale", () => {
      const timeWindow = 1;
      const oldTimestamp = timestampFromMs(baseTime - 1_500);
      const oldSignature = computeWebhookSignature(TEST_SECRET, oldTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        oldTimestamp,
        TEST_BODY,
        oldSignature,
        timeWindow,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "stale"
      });
    });
  });

  describe("Production Behavior (No Clock Injection)", () => {
    it("uses real Date.now() when clock parameter is omitted", () => {
      const now = Date.now();
      const nowTimestamp = new Date(now).toISOString();
      const signature = computeWebhookSignature(TEST_SECRET, nowTimestamp, TEST_BODY);

      // Should accept within a reasonable margin (allows for test execution time)
      const result = verifyWebhookSignature(
        TEST_SECRET,
        nowTimestamp,
        TEST_BODY,
        signature,
        300
        // NO clock parameter - uses real Date.now()
      );

      expect(result.valid).toBe(true);
    });

    it("rejects significantly old timestamp in production mode", () => {
      const pastTime = Date.now() - 400_000; // 400s ago
      const pastTimestamp = new Date(pastTime).toISOString();
      const signature = computeWebhookSignature(TEST_SECRET, pastTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        pastTimestamp,
        TEST_BODY,
        signature,
        300
        // NO clock parameter - uses real Date.now()
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "stale"
      });
    });
  });

  describe("Error Message Clarity", () => {
    it("includes skew delta in stale error message", () => {
      const staleTimestamp = timestampFromMs(baseTime - 350_000); // 350s old
      const staleSignature = computeWebhookSignature(TEST_SECRET, staleTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        staleTimestamp,
        TEST_BODY,
        staleSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "stale"
      });
      if (!result.valid) {
        expect(result.reason).toContain("350"); // Delta in message
      }
    });

    it("includes skew delta in future error message", () => {
      const futureTimestamp = timestampFromMs(baseTime + 100_000); // 100s ahead
      const futureSignature = computeWebhookSignature(TEST_SECRET, futureTimestamp, TEST_BODY);

      const result = verifyWebhookSignature(
        TEST_SECRET,
        futureTimestamp,
        TEST_BODY,
        futureSignature,
        TEST_REPLAY_WINDOW_SECONDS,
        baseClock
      );

      expect(result).toMatchObject({
        valid: false,
        errorType: "future"
      });
      if (!result.valid) {
        expect(result.reason).toContain("100"); // Delta in message
      }
    });
  });
});
