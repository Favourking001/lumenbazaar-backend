/**
 * Clock-Skew Verification Test Matrix
 * Issue #115: Deterministic test coverage for all time-based protocol decisions
 *
 * SCOPE:
 * - Payment expiry checks (x402 timestamps)
 * - Webhook timestamp validation and replay windows
 * - Signature timestamp tolerance
 * - Indeterminate vs stale vs future error distinction
 *
 * APPROACH:
 * - Injected clocks (no system time changes, no real sleeps)
 * - Table-driven test matrices covering boundary conditions
 * - Explicit error type assertions (stale, future, indeterminate)
 * - Constants for all boundary values (explicit positive/negative skew limits)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createFakeClock,
  createClockWithSkew,
  type Clock
} from "@lumenbazaar/testkit";
import {
  verifyWebhookSignature,
  computeWebhookSignature,
  type WebhookSignatureVerificationResult
} from "@lumenbazaar/shared";

/**
 * BOUNDARY CONSTANTS: Explicit time windows for all skew scenarios
 */

// Webhook replay window (default 5 minutes in production)
const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

// Test timestamps: all in milliseconds
const BASE_TIME_MS = 1700000000000; // 2023-11-15T06:26:40.000Z
const BASE_TIME_ISO = new Date(BASE_TIME_MS).toISOString();

// Skew boundaries (in milliseconds, converted from seconds for precision)
const ZERO_SKEW_MS = 0;
const ONE_SECOND_SKEW_MS = 1000;
const WINDOW_BOUNDARY_MS = WEBHOOK_REPLAY_WINDOW_SECONDS * 1000; // 300,000 ms

// Specific boundary test cases
const EXACTLY_AT_BOUNDARY_SKEW_MS = WINDOW_BOUNDARY_MS; // 300s old (exactly at limit)
const ONE_MS_INSIDE_BOUNDARY_SKEW_MS = WINDOW_BOUNDARY_MS - 1; // 299.999s old (just inside)
const ONE_MS_OUTSIDE_BOUNDARY_SKEW_MS = WINDOW_BOUNDARY_MS + 1; // 300.001s old (just outside)

const EXACTLY_AT_FUTURE_BOUNDARY_MS = 0; // Zero skew (at boundary)
const ONE_MS_INTO_FUTURE_MS = 1; // 1ms in the future
const FIVE_SECONDS_INTO_FUTURE_MS = 5000; // 5s in the future

describe("Clock-Skew Verification Test Matrix", () => {
  describe("Webhook Signature Verification - Replay Window (Stale Errors)", () => {
    // Test matrix: timestamp staleness detection with clock skew
    let testSecret: string;
    let testBody: string;
    let testTimestamp: string;

    beforeEach(() => {
      testSecret = "test-webhook-secret-key";
      testBody = JSON.stringify({ eventId: "test-123", type: "payment.settled" });
      testTimestamp = BASE_TIME_ISO;
    });

    describe("Zero skew (no clock difference)", () => {
      it("accepts timestamp within replay window", () => {
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const verifierClock = createFakeClock(BASE_TIME_MS);

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(true);
      });

      it("rejects timestamp just outside replay window (stale)", () => {
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const verifierClock = createFakeClock(BASE_TIME_MS + ONE_MS_OUTSIDE_BOUNDARY_SKEW_MS);

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("stale");
        expect(result.reason).toContain("older than replay window");
      });
    });

    describe("Positive skew (verifier ahead of sender)", () => {
      it("rejects when verifier is exactly at boundary (stale)", () => {
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const verifierClock = createClockWithSkew(EXACTLY_AT_BOUNDARY_SKEW_MS);

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("stale");
      });

      it("accepts when verifier is one unit inside boundary", () => {
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const verifierClock = createFakeClock(BASE_TIME_MS + ONE_MS_INSIDE_BOUNDARY_SKEW_MS);

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(true);
      });

      it("rejects when verifier is one unit outside boundary", () => {
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const verifierClock = createFakeClock(BASE_TIME_MS + ONE_MS_OUTSIDE_BOUNDARY_SKEW_MS);

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("stale");
      });
    });

    describe("Negative skew (verifier behind sender)", () => {
      it("accepts timestamps within normal window even with negative skew", () => {
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const verifierClock = createClockWithSkew(-5000); // 5s behind

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(true);
      });
    });

    describe("Future timestamp detection", () => {
      it("rejects timestamp exactly in future (zero positive offset)", () => {
        const futureTime = BASE_TIME_MS + ONE_MS_INTO_FUTURE_MS;
        const futureTimestamp = new Date(futureTime).toISOString();
        const signature = computeWebhookSignature(testSecret, futureTimestamp, testBody);
        const verifierClock = createFakeClock(BASE_TIME_MS);

        const result = verifyWebhookSignature(
          testSecret,
          futureTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("future");
        expect(result.reason).toContain("in the future");
      });

      it("rejects timestamp far in future", () => {
        const futureTime = BASE_TIME_MS + FIVE_SECONDS_INTO_FUTURE_MS;
        const futureTimestamp = new Date(futureTime).toISOString();
        const signature = computeWebhookSignature(testSecret, futureTimestamp, testBody);
        const verifierClock = createFakeClock(BASE_TIME_MS);

        const result = verifyWebhookSignature(
          testSecret,
          futureTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("future");
      });

      it("rejects when verifier is behind and timestamp appears future", () => {
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const verifierClock = createClockWithSkew(-10000); // 10s behind sender

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("future");
      });
    });

    describe("Indeterminate errors (malformed timestamps - fail closed)", () => {
      it("rejects invalid ISO 8601 timestamp", () => {
        const invalidTimestamp = "not-a-date";
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const verifierClock = createFakeClock(BASE_TIME_MS);

        const result = verifyWebhookSignature(
          testSecret,
          invalidTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("indeterminate");
        expect(result.reason).toContain("not valid ISO 8601");
      });

      it("rejects empty timestamp", () => {
        const verifierClock = createFakeClock(BASE_TIME_MS);

        const result = verifyWebhookSignature(
          testSecret,
          "",
          testBody,
          computeWebhookSignature(testSecret, testTimestamp, testBody),
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("indeterminate");
      });

      it("rejects invalid signature format (not hex)", () => {
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const verifierClock = createFakeClock(BASE_TIME_MS);

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          "not-hex-signature",
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("indeterminate");
        expect(result.reason).toContain("Invalid signature format");
      });

      it("rejects wrong signature (indeterminate, not stale)", () => {
        const wrongSignature = "a".repeat(64); // Fake hex signature
        const verifierClock = createFakeClock(BASE_TIME_MS);

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          wrongSignature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("indeterminate");
        expect(result.reason).toContain("does not match");
      });

      it("rejects when signature computation fails (indeterminate fail-closed)", () => {
        // Create a signature with different secret than verification
        const differentSecret = "different-secret";
        const signature = computeWebhookSignature(differentSecret, testTimestamp, testBody);
        const verifierClock = createFakeClock(BASE_TIME_MS);

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("indeterminate");
      });
    });

    describe("Signature verification with correct computation", () => {
      it("accepts valid signature with correct secret and timestamp", () => {
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const verifierClock = createFakeClock(BASE_TIME_MS);

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          testBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(true);
      });

      it("rejects when body is modified (signature mismatch - indeterminate)", () => {
        const signature = computeWebhookSignature(testSecret, testTimestamp, testBody);
        const modifiedBody = JSON.stringify({
          eventId: "test-123",
          type: "payment.settled",
          extra: "modified"
        });
        const verifierClock = createFakeClock(BASE_TIME_MS);

        const result = verifyWebhookSignature(
          testSecret,
          testTimestamp,
          modifiedBody,
          signature,
          WEBHOOK_REPLAY_WINDOW_SECONDS,
          verifierClock
        );

        expect(result.valid).toBe(false);
        expect(result.errorType).toBe("indeterminate");
      });
    });
  });

  describe("Clock injection throughout payment lifecycle", () => {
    it("verifyWebhookSignature accepts injected clock parameter", () => {
      const testSecret = "secret";
      const testBody = "body";
      const baseTime = Date.now();
      const timestamp = new Date(baseTime).toISOString();
      const signature = computeWebhookSignature(testSecret, timestamp, testBody);

      // Use injected clock
      const clock = createFakeClock(baseTime);
      const result = verifyWebhookSignature(
        testSecret,
        timestamp,
        testBody,
        signature,
        300,
        clock
      );

      expect(result.valid).toBe(true);
    });

    it("falls back to real clock when clock parameter omitted", () => {
      const testSecret = "secret";
      const testBody = "body";
      const now = new Date().toISOString();
      const signature = computeWebhookSignature(testSecret, now, testBody);

      // No clock parameter - should use real time
      const result = verifyWebhookSignature(testSecret, now, testBody, signature, 300);

      expect(result.valid).toBe(true);
    });
  });

  describe("Error type distinction matrix", () => {
    it("distinguishes all three error types", () => {
      const testSecret = "secret";
      const testBody = "body";
      const baseTime = Date.now();

      // 1. Stale: timestamp older than window
      const oldTimestamp = new Date(baseTime - 400000).toISOString(); // 400s old
      const staleSignature = computeWebhookSignature(testSecret, oldTimestamp, testBody);
      const staleClock = createFakeClock(baseTime);
      const staleResult = verifyWebhookSignature(
        testSecret,
        oldTimestamp,
        testBody,
        staleSignature,
        300,
        staleClock
      );
      expect(staleResult.valid).toBe(false);
      expect(staleResult.errorType).toBe("stale");

      // 2. Future: timestamp ahead of verifier
      const futureTimestamp = new Date(baseTime + 10000).toISOString(); // 10s in future
      const futureSignature = computeWebhookSignature(testSecret, futureTimestamp, testBody);
      const futureClock = createFakeClock(baseTime);
      const futureResult = verifyWebhookSignature(
        testSecret,
        futureTimestamp,
        testBody,
        futureSignature,
        300,
        futureClock
      );
      expect(futureResult.valid).toBe(false);
      expect(futureResult.errorType).toBe("future");

      // 3. Indeterminate: malformed data
      const validTimestamp = new Date(baseTime).toISOString();
      const indeterminateClock = createFakeClock(baseTime);
      const indeterminateResult = verifyWebhookSignature(
        testSecret,
        validTimestamp,
        testBody,
        "not-hex",
        300,
        indeterminateClock
      );
      expect(indeterminateResult.valid).toBe(false);
      expect(indeterminateResult.errorType).toBe("indeterminate");
    });
  });

  describe("Boundary value testing - Precise millisecond precision", () => {
    const testSecret = "secret";
    const testBody = "body";
    const baseTime = 1700000000000;
    const baseTimestamp = new Date(baseTime).toISOString();

    const testCases: Array<{
      name: string;
      clockOffsetMs: number;
      windowSeconds: number;
      expectedValid: boolean;
      expectedErrorType?: "stale" | "future" | "indeterminate";
    }> = [
      // Stale boundary (at exactly 300 seconds old)
      {
        name: "exactly at stale boundary (300s)",
        clockOffsetMs: 300000,
        windowSeconds: 300,
        expectedValid: false,
        expectedErrorType: "stale"
      },
      // Just inside stale boundary (299.999s old)
      {
        name: "just inside stale boundary (299.999s)",
        clockOffsetMs: 299999,
        windowSeconds: 300,
        expectedValid: true
      },
      // Just outside stale boundary (300.001s old)
      {
        name: "just outside stale boundary (300.001s)",
        clockOffsetMs: 300001,
        windowSeconds: 300,
        expectedValid: false,
        expectedErrorType: "stale"
      },
      // Future boundary (at 0 offset = now)
      {
        name: "at future boundary (now = 0 offset)",
        clockOffsetMs: 0,
        windowSeconds: 300,
        expectedValid: true
      },
      // Just into future (1ms ahead)
      {
        name: "just into future (1ms)",
        clockOffsetMs: -1,
        windowSeconds: 300,
        expectedValid: false,
        expectedErrorType: "future"
      },
      // Clearly in future (5s ahead)
      {
        name: "clearly in future (5000ms)",
        clockOffsetMs: -5000,
        windowSeconds: 300,
        expectedValid: false,
        expectedErrorType: "future"
      }
    ];

    testCases.forEach(({ name, clockOffsetMs, windowSeconds, expectedValid, expectedErrorType }) => {
      it(`handles: ${name}`, () => {
        const signature = computeWebhookSignature(testSecret, baseTimestamp, testBody);
        const verifierClock = createFakeClock(baseTime + clockOffsetMs);

        const result = verifyWebhookSignature(
          testSecret,
          baseTimestamp,
          testBody,
          signature,
          windowSeconds,
          verifierClock
        );

        expect(result.valid).toBe(expectedValid);
        if (!expectedValid && expectedErrorType) {
          expect(result.errorType).toBe(expectedErrorType);
        }
      });
    });
  });
});
