import {
  computeBackoffMs,
  isRetryableFailure,
} from "../../../src/services/retry";

describe("retry policy", () => {
  const config = { baseDelayMs: 100, maxDelayMs: 150 };

  it("keeps equal jitter inside [exp/2, exp] and caps the exponential", () => {
    expect(
      computeBackoffMs(1, { baseDelayMs: 100, maxDelayMs: 1000 }, () => 0),
    ).toBe(50);
    expect(
      computeBackoffMs(1, { baseDelayMs: 100, maxDelayMs: 1000 }, () => 0.999),
    ).toBe(99);
    expect(computeBackoffMs(3, config, () => 0)).toBe(75);
    expect(computeBackoffMs(3, config, () => 0.999)).toBe(149);
  });

  it("retries transient failures and stops on a permanent decline", () => {
    expect(isRetryableFailure("timeout")).toBe(true);
    expect(isRetryableFailure("unavailable")).toBe(true);
    expect(isRetryableFailure("unknown")).toBe(true);
    expect(isRetryableFailure("declined")).toBe(false);
  });

  it("rejects a bad attempt or random source", () => {
    expect(() => computeBackoffMs(0, config, () => 0)).toThrow(/attempt/);
    expect(() => computeBackoffMs(1, config, () => 1)).toThrow(/random/);
  });
});
