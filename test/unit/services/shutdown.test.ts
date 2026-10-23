import { createServer, type Server } from "node:http";
import { MemoryPaymentRepository } from "../../../src/adapters/persistence/memory-payment-repository";
import { InProcessJobQueue } from "../../../src/adapters/queue/in-process-job-queue";
import { PaymentProcessor } from "../../../src/services/payment-processor";
import { PaymentService } from "../../../src/services/payment-service";
import { gracefulShutdown } from "../../../src/services/shutdown";
import {
  BlockingGateway,
  FakeClock,
  PAYMENT_ID,
  createMockLogger,
} from "../../helpers/fixtures";

describe("graceful shutdown", () => {
  async function harness() {
    const repository = new MemoryPaymentRepository();
    const clock = new FakeClock();
    const logger = createMockLogger();
    const gateway = new BlockingGateway();
    const queue = new InProcessJobQueue(clock, 1, () => undefined);
    const processor = new PaymentProcessor({
      repository,
      gateway,
      queue,
      clock,
      random: () => 0,
      logger,
      maxAttempts: 3,
      leaseMs: 5_000,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      gatewayTimeoutMs: 1_000,
    });
    const service = new PaymentService({
      repository,
      queue,
      clock,
      ids: { uuid: () => PAYMENT_ID },
      logger,
    });
    queue.start((paymentId) => processor.process(paymentId));
    await service.create(
      {
        amount: 100,
        currency: "NGN",
        paymentMethod: { type: "card", token: "tok_4242" },
      },
      { clientId: "demo", idempotencyKey: "order-1042-key" },
    );
    await gateway.started.promise;
    const server = createServer((_req, res) => {
      res.end("ok");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    const readiness = { shuttingDown: false };
    let reconcilerStopped = false;
    return {
      repository,
      gateway,
      queue,
      logger,
      server,
      readiness,
      reconcilerStopped: () => reconcilerStopped,
      markStopped: () => {
        reconcilerStopped = true;
      },
    };
  }

  it("drains an in-flight charge before closing storage", async () => {
    const context = await harness();
    const pending = gracefulShutdown({
      server: context.server,
      queue: context.queue,
      closeStorage: () => context.repository.close(),
      drainMs: 1_000,
      logger: context.logger,
      markNotReady: () => {
        context.readiness.shuttingDown = true;
      },
      stopReconciler: context.markStopped,
    });
    context.gateway.release.resolve();
    const result = await pending;
    expect(result.drained).toBe(true);
    expect(context.readiness.shuttingDown).toBe(true);
    expect((await context.repository.findById(PAYMENT_ID))?.status).toBe(
      "SUCCEEDED",
    );
  });

  it("returns before a stuck charge finishes and leaves the payment PROCESSING", async () => {
    const context = await harness();
    const result = await gracefulShutdown({
      server: context.server,
      queue: context.queue,
      closeStorage: () => context.repository.close(),
      drainMs: 40,
      logger: context.logger,
      markNotReady: () => {
        context.readiness.shuttingDown = true;
      },
      stopReconciler: context.markStopped,
    });
    expect(result).toEqual({ drained: false, inflight: 1 });
    expect((await context.repository.findById(PAYMENT_ID))?.status).toBe(
      "PROCESSING",
    );
    context.gateway.release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it("rejects when the server fails to close", async () => {
    const server = {
      close(callback: (error?: Error) => void) {
        const error = new Error("close failed") as NodeJS.ErrnoException;
        error.code = "EIO";
        callback(error);
      },
    } as Server;
    await expect(
      gracefulShutdown({
        server,
        queue: {
          enqueue() {},
          start() {},
          pause() {},
          async drain() {
            return { drained: true, inflight: 0 };
          },
        },
        closeStorage: async () => undefined,
        drainMs: 10,
        logger: createMockLogger(),
        markNotReady: () => undefined,
        stopReconciler: () => undefined,
      }),
    ).rejects.toThrow("close failed");
  });
});
