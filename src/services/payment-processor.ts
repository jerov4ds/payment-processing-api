import {
  GatewayTimeoutError,
  GatewayUnavailableError,
  PaymentDeclinedError,
} from "../domain/errors";
import {
  claimForProcessing,
  leaseExpired,
  markFailed,
  markSucceeded,
  reclaimProcessing,
  releaseForRetry,
  type FailureReason,
  type Payment,
} from "../domain/payment";
import type { Clock } from "../ports/clock";
import type { JobQueue } from "../ports/job-queue";
import type { AppLogger } from "../ports/logger";
import type { PaymentGateway } from "../ports/payment-gateway";
import type { PaymentRepository } from "../repositories/payment-repository";
import {
  computeBackoffMs,
  isRetryableFailure,
  type FailureClass,
} from "./retry";

export interface PaymentProcessorDeps {
  repository: PaymentRepository;
  gateway: PaymentGateway;
  queue: JobQueue;
  clock: Clock;
  random: () => number;
  logger: AppLogger;
  maxAttempts: number;
  leaseMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  gatewayTimeoutMs: number;
}

export class PaymentProcessor {
  constructor(private readonly deps: PaymentProcessorDeps) {}

  async process(paymentId: string): Promise<void> {
    try {
      await this.run(paymentId);
    } catch (error) {
      this.deps.logger.error(
        { err: error, paymentId },
        "payment processing failed",
      );
    }
  }

  async recover(): Promise<number> {
    const nowIso = this.deps.clock.now().toISOString();
    const due = await this.deps.repository.listRecoverable(
      nowIso,
      this.deps.leaseMs,
    );
    for (const payment of due) {
      this.deps.queue.enqueue({
        paymentId: payment.id,
        runAt: this.deps.clock.now(),
      });
    }
    if (due.length > 0) {
      this.deps.logger.info(
        { count: due.length },
        "enqueued recoverable payments",
      );
    }
    return due.length;
  }

  private async run(paymentId: string): Promise<void> {
    const claimed = await this.claim(paymentId);
    if (!claimed) {
      return;
    }
    try {
      await this.deps.gateway.charge({
        paymentId: claimed.id,
        amount: claimed.amount,
        currency: claimed.currency,
        attempt: claimed.attempts,
        timeoutMs: this.deps.gatewayTimeoutMs,
      });
      await this.commit(claimed.id, claimed.version, (current, now) =>
        markSucceeded(current, now),
      );
    } catch (error) {
      const failure = classify(error);
      const reason = failureReasonFor(failure);
      if (
        !isRetryableFailure(failure) ||
        claimed.attempts >= this.deps.maxAttempts
      ) {
        await this.commit(claimed.id, claimed.version, (current, now) =>
          markFailed(current, reason, now),
        );
        return;
      }
      const delay = computeBackoffMs(
        claimed.attempts,
        {
          baseDelayMs: this.deps.retryBaseDelayMs,
          maxDelayMs: this.deps.retryMaxDelayMs,
        },
        this.deps.random,
      );
      const runAt = new Date(this.deps.clock.now().getTime() + delay);
      const released = await this.commit(
        claimed.id,
        claimed.version,
        (current, now) => releaseForRetry(current, now, runAt),
      );
      if (!released) {
        return;
      }
      this.deps.queue.enqueue({ paymentId, runAt });
    }
  }

  private async claim(paymentId: string): Promise<Payment | null> {
    return this.deps.repository.withTransaction(async (tx) => {
      const payment = await tx.findByIdForUpdate(paymentId);
      if (!payment) {
        this.deps.logger.warn({ paymentId }, "payment missing; job ignored");
        return null;
      }
      if (payment.status !== "PENDING" && payment.status !== "PROCESSING") {
        return null;
      }
      const now = this.deps.clock.now();
      if (payment.status === "PROCESSING") {
        if (!leaseExpired(payment, now, this.deps.leaseMs)) {
          return null;
        }
        return tx.update(reclaimProcessing(payment, now), payment.version);
      }
      return tx.update(claimForProcessing(payment, now), payment.version);
    });
  }

  private async commit(
    id: string,
    version: number,
    build: (current: Payment, now: Date) => Payment,
  ): Promise<boolean> {
    return this.deps.repository.withTransaction(async (tx) => {
      const current = await tx.findByIdForUpdate(id);
      if (
        !current ||
        current.version !== version ||
        current.status !== "PROCESSING"
      ) {
        this.deps.logger.warn(
          {
            paymentId: id,
            expectedVersion: version,
            version: current?.version,
            status: current?.status,
          },
          "skipped payment completion write",
        );
        return false;
      }
      await tx.update(build(current, this.deps.clock.now()), current.version);
      return true;
    });
  }
}

function classify(error: unknown): FailureClass {
  if (error instanceof GatewayTimeoutError) {
    return "timeout";
  }
  if (error instanceof GatewayUnavailableError) {
    return "unavailable";
  }
  if (error instanceof PaymentDeclinedError) {
    return "declined";
  }
  return "unknown";
}

function failureReasonFor(failure: FailureClass): FailureReason {
  if (failure === "timeout") {
    return "GATEWAY_TIMEOUT";
  }
  if (failure === "declined") {
    return "PAYMENT_DECLINED";
  }
  return "GATEWAY_UNAVAILABLE";
}
