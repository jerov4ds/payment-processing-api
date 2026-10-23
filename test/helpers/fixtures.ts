import type { PaymentGateway } from "../../src/ports/payment-gateway";
import type { JobQueue, QueueJob } from "../../src/ports/job-queue";
import type { AppLogger } from "../../src/ports/logger";
import type { Clock } from "../../src/ports/clock";
import {
  GatewayTimeoutError,
  GatewayUnavailableError,
  PaymentDeclinedError,
} from "../../src/domain/errors";
import type { Payment } from "../../src/domain/payment";

export const NOW = new Date("2026-01-15T12:00:00.000Z");

export const PAYMENT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
export const OTHER_PAYMENT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa7";

export function samplePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: PAYMENT_ID,
    clientId: "demo",
    amount: 150000,
    currency: "NGN",
    status: "PENDING",
    description: "Order 1042",
    metadata: { orderId: "1042" },
    idempotencyKey: "order-1042-key",
    paymentMethod: { type: "card", last4: "4242" },
    statusReason: null,
    failureReason: null,
    attempts: 0,
    version: 1,
    processingStartedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

export class FakeClock implements Clock {
  constructor(private current = NOW) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function createMockLogger(): AppLogger & {
  entries: { level: string; obj: object; msg?: string }[];
} {
  const entries: { level: string; obj: object; msg?: string }[] = [];
  const write =
    (level: string) =>
    (obj: object, msg?: string): void => {
      entries.push({ level, obj, msg });
    };
  return {
    entries,
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    fatal: write("fatal"),
  };
}

export class RecordingQueue implements JobQueue {
  jobs: QueueJob[] = [];
  started = false;

  enqueue(job: QueueJob): void {
    this.jobs.push(job);
  }

  start(): void {
    this.started = true;
  }

  pause(): void {}

  async drain(): Promise<{ drained: boolean; inflight: number }> {
    return { drained: true, inflight: 0 };
  }
}

export class ThrowingQueue extends RecordingQueue {
  override enqueue(): void {
    throw new Error("queue is full");
  }
}

export type GatewayStep = "ok" | "transient" | "timeout" | "declined";

export class ScriptedGateway implements PaymentGateway {
  calls: { paymentId: string; attempt: number }[] = [];

  constructor(private readonly steps: GatewayStep[]) {}

  async charge(command: {
    paymentId: string;
    attempt: number;
  }): Promise<{ approved: true }> {
    const step = this.steps[this.calls.length] ?? "ok";
    this.calls.push({ paymentId: command.paymentId, attempt: command.attempt });
    if (step === "transient") {
      throw new GatewayUnavailableError();
    }
    if (step === "timeout") {
      throw new GatewayTimeoutError();
    }
    if (step === "declined") {
      throw new PaymentDeclinedError();
    }
    return { approved: true };
  }
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export class BlockingGateway implements PaymentGateway {
  readonly started = deferred<void>();
  readonly release = deferred<void>();

  async charge(): Promise<{ approved: true }> {
    this.started.resolve();
    await this.release.promise;
    return { approved: true };
  }
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
