import { InvalidTransitionError } from "../../../src/domain/errors";
import {
  applyClientTransition,
  claimForProcessing,
  markFailed,
  markSucceeded,
  reclaimProcessing,
  releaseForRetry,
} from "../../../src/domain/payment";
import {
  assertCanTransition,
  canTransition,
  isClientStatus,
  isTerminal,
  type PaymentStatus,
} from "../../../src/domain/payment-state-machine";
import { NOW, samplePayment } from "../../helpers/fixtures";

const LEGAL: Array<[PaymentStatus, PaymentStatus]> = [
  ["PENDING", "PROCESSING"],
  ["PENDING", "CANCELLED"],
  ["PROCESSING", "SUCCEEDED"],
  ["PROCESSING", "FAILED"],
  ["PROCESSING", "PENDING"],
  ["SUCCEEDED", "REFUNDED"],
];

const ILLEGAL: Array<[PaymentStatus, PaymentStatus]> = [
  ["PENDING", "SUCCEEDED"],
  ["PENDING", "FAILED"],
  ["PENDING", "REFUNDED"],
  ["PROCESSING", "CANCELLED"],
  ["PROCESSING", "REFUNDED"],
  ["SUCCEEDED", "FAILED"],
  ["SUCCEEDED", "CANCELLED"],
  ["FAILED", "PENDING"],
  ["FAILED", "REFUNDED"],
  ["CANCELLED", "PENDING"],
  ["REFUNDED", "SUCCEEDED"],
  ["SUCCEEDED", "SUCCEEDED"],
];

describe("payment state machine", () => {
  it.each(LEGAL)("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertCanTransition(from, to)).not.toThrow();
  });

  it.each(ILLEGAL)("rejects %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertCanTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it("treats failed, cancelled, and refunded as terminal", () => {
    expect(isTerminal("FAILED")).toBe(true);
    expect(isTerminal("CANCELLED")).toBe(true);
    expect(isTerminal("REFUNDED")).toBe(true);
    expect(isTerminal("SUCCEEDED")).toBe(false);
    expect(isTerminal("PENDING")).toBe(false);
    expect(isTerminal("PROCESSING")).toBe(false);
    expect(isClientStatus("CANCELLED")).toBe(true);
    expect(isClientStatus("SUCCEEDED")).toBe(false);
  });

  it("applies client and worker transitions and bumps the version", () => {
    const pending = samplePayment();
    const claimed = claimForProcessing(pending, NOW);
    expect(claimed).toMatchObject({
      status: "PROCESSING",
      attempts: 1,
      version: 2,
    });
    const retryAt = new Date(NOW.getTime() + 100);
    const released = releaseForRetry(claimed, NOW, retryAt);
    expect(released.status).toBe("PENDING");
    expect(released.processingStartedAt).toBeNull();
    expect(released.nextAttemptAt).toBe(retryAt.toISOString());
    const again = claimForProcessing(released, NOW);
    expect(again.nextAttemptAt).toBeNull();
    const succeeded = markSucceeded(again, NOW);
    expect(succeeded.status).toBe("SUCCEEDED");
    const refunded = applyClientTransition(
      succeeded,
      { status: "REFUNDED", reason: "customer" },
      NOW,
    );
    expect(refunded).toMatchObject({
      status: "REFUNDED",
      statusReason: "customer",
    });
    const failed = markFailed(again, "PAYMENT_DECLINED", NOW);
    expect(failed.failureReason).toBe("PAYMENT_DECLINED");
  });

  it("refreshes a processing lease without incrementing attempts", () => {
    const processing = samplePayment({
      status: "PROCESSING",
      attempts: 2,
      version: 4,
      processingStartedAt: "2026-01-15T11:00:00.000Z",
    });
    const reclaimed = reclaimProcessing(processing, NOW);
    expect(reclaimed.attempts).toBe(2);
    expect(reclaimed.version).toBe(5);
    expect(reclaimed.processingStartedAt).toBe(NOW.toISOString());
    expect(() => reclaimProcessing(samplePayment(), NOW)).toThrow(/PROCESSING/);
  });

  it("refuses a client cancel once processing has started", () => {
    const processing = claimForProcessing(samplePayment(), NOW);
    expect(() =>
      applyClientTransition(processing, { status: "CANCELLED" }, NOW),
    ).toThrow(InvalidTransitionError);
  });
});
