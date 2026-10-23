export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
}

export type FailureClass = "timeout" | "unavailable" | "declined" | "unknown";

/**
 * Equal jitter: delay is in [exp/2, exp], where exp = min(cap, base * 2^(attempt-1)).
 * `random` returns a value in [0, 1).
 */
export function computeBackoffMs(
  attempt: number,
  config: BackoffConfig,
  random: () => number,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be an integer >= 1");
  }
  const roll = random();
  if (roll < 0 || roll >= 1) {
    throw new Error("random() must return a value in [0, 1)");
  }
  const exponential = config.baseDelayMs * 2 ** (attempt - 1);
  const exp = Math.min(config.maxDelayMs, exponential);
  return Math.floor(exp / 2 + roll * (exp / 2));
}

export function isRetryableFailure(failure: FailureClass): boolean {
  return failure !== "declined";
}
