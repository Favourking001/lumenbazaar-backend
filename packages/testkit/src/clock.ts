/**
 * Clock abstraction for time-sensitive testing.
 * Allows injecting synthetic time sources into time-dependent logic.
 *
 * INJECTABLE: Designed for test matrix validation of clock-skew scenarios.
 * PRODUCTION: Default implementation delegates to real Date.now()
 */

/**
 * Minimal clock interface for injectable time sources.
 */
export interface Clock {
  /**
   * Returns current Unix timestamp in milliseconds.
   * Compatible with Date.now().
   */
  now(): number;
}

/**
 * Real clock using system time.
 * Default for production; always available as fallback.
 */
export const realClock: Clock = {
  now(): number {
    return Date.now();
  }
};

/**
 * Synthetic clock for testing.
 * Initialized to a fixed time and allows manual advancement.
 */
export class FakeClock implements Clock {
  private currentTime: number;

  /**
   * @param initialTime - Initial timestamp in milliseconds (default: now)
   */
  constructor(initialTime: number = Date.now()) {
    this.currentTime = initialTime;
  }

  /**
   * Returns current synthetic time.
   */
  now(): number {
    return this.currentTime;
  }

  /**
   * Advance time by delta milliseconds.
   * @param deltaMs - Milliseconds to advance (can be negative)
   */
  advance(deltaMs: number): void {
    this.currentTime += deltaMs;
  }

  /**
   * Set time to absolute value.
   * @param absoluteTime - Absolute Unix timestamp in milliseconds
   */
  setTime(absoluteTime: number): void {
    this.currentTime = absoluteTime;
  }

  /**
   * Set time to relative offset from current time.
   * @param offsetMs - Milliseconds offset (positive = future, negative = past)
   */
  setOffset(offsetMs: number): void {
    this.currentTime = Date.now() + offsetMs;
  }
}

/**
 * Create a fake clock for testing.
 * @param initialTime - Initial time (default: now)
 * @returns FakeClock instance
 */
export function createFakeClock(initialTime?: number): FakeClock {
  return new FakeClock(initialTime);
}

/**
 * Helper: Create a clock offset by delta from now.
 * Useful for skew simulation in test setup.
 *
 * @param skewMs - Clock skew in milliseconds (positive = ahead, negative = behind)
 * @returns FakeClock initialized to now + skewMs
 *
 * @example
 * const clockSkewedAhead = createClockWithSkew(5000);  // 5s ahead
 * const clockSkewedBehind = createClockWithSkew(-5000); // 5s behind
 */
export function createClockWithSkew(skewMs: number): FakeClock {
  return new FakeClock(Date.now() + skewMs);
}
