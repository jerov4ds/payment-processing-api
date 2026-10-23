import { MemoryPaymentRepository } from "../../../src/adapters/persistence/memory-payment-repository";
import { GatewayUnavailableError } from "../../../src/domain/errors";
import type { PaymentGateway } from "../../../src/ports/payment-gateway";
import { PaymentProcessor } from "../../../src/services/payment-processor";
import { PaymentService } from "../../../src/services/payment-service";
import {
  FakeClock,
  PAYMENT_ID,
  RecordingQueue,
  ScriptedGateway,
  createMockLogger,
} from "../../helpers/fixtures";

const input = {
  amount: 150000,
  currency: "NGN" as const,
  description: "Order 1042",
  paymentMethod: { type: "card", token: "tok_visa_4242" },
};

describe("payment processor", () => {
  function build(options?: {
    steps?: Array<"ok" | "transient" | "timeout" | "declined">;
    gateway?: PaymentGateway;
    maxAttempts?: number;
    leaseMs?: number;
  }) {
    const repository = new MemoryPaymentRepository();
    const queue = new RecordingQueue();
    const clock = new FakeClock();
    const logger = createMockLogger();
    const gateway =
      options?.gateway ?? new ScriptedGateway(options?.steps ?? ["ok"]);
    const processor = new PaymentProcessor({
      repository,
      gateway,
      queue,
      clock,
      random: () => 0,
      logger,
      maxAttempts: options?.maxAttempts ?? 3,
      leaseMs: options?.leaseMs ?? 5_000,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      gatewayTimeoutMs: 1_000,
    });
    const service = new PaymentService({
      repository,
      queue,
      clock,
      ids: { uuid: () => PAYMENT_ID },
      logger,
    });
    return { repository, queue, clock, logger, gateway, processor, service };
  }

  async function seed(): Promise<ReturnType<typeof build>> {
    const context = build();
    await context.service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    context.queue.jobs.length = 0;
    return context;
  }

  it("moves a pending payment to succeeded", async () => {
    const { processor, repository, gateway } = await seed();
    await processor.process(PAYMENT_ID);
    const payment = await repository.findById(PAYMENT_ID);
    expect(payment).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
      failureReason: null,
    });
    expect((gateway as ScriptedGateway).calls).toEqual([
      { paymentId: PAYMENT_ID, attempt: 1 },
    ]);
  });

  it("fails a permanent decline without a retry", async () => {
    const context = build({ steps: ["declined"] });
    await context.service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    context.queue.jobs.length = 0;
    await context.processor.process(PAYMENT_ID);
    expect(await context.repository.findById(PAYMENT_ID)).toMatchObject({
      status: "FAILED",
      failureReason: "PAYMENT_DECLINED",
      attempts: 1,
    });
    expect(context.queue.jobs).toHaveLength(0);
  });

  it("retries a transient failure and then succeeds", async () => {
    const context = build({ steps: ["transient", "ok"] });
    await context.service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    context.queue.jobs.length = 0;
    await context.processor.process(PAYMENT_ID);
    expect(await context.repository.findById(PAYMENT_ID)).toMatchObject({
      status: "PENDING",
      attempts: 1,
    });
    expect(context.queue.jobs).toHaveLength(1);
    expect(context.queue.jobs[0]?.runAt.getTime()).toBe(
      context.clock.now().getTime() + 50,
    );
    await context.processor.process(PAYMENT_ID);
    expect(await context.repository.findById(PAYMENT_ID)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 2,
    });
  });

  it("fails when transient errors exhaust the attempt budget", async () => {
    const context = build({ steps: ["timeout", "timeout"], maxAttempts: 2 });
    await context.service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    await context.processor.process(PAYMENT_ID);
    await context.processor.process(PAYMENT_ID);
    expect(await context.repository.findById(PAYMENT_ID)).toMatchObject({
      status: "FAILED",
      failureReason: "GATEWAY_TIMEOUT",
      attempts: 2,
    });
  });

  it("treats an unknown gateway error as retryable, then fails at the cap", async () => {
    const context = build({
      maxAttempts: 1,
      gateway: {
        async charge() {
          throw new Error("socket hang up");
        },
      },
    });
    await context.service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    await context.processor.process(PAYMENT_ID);
    expect(await context.repository.findById(PAYMENT_ID)).toMatchObject({
      status: "FAILED",
      failureReason: "GATEWAY_UNAVAILABLE",
    });
  });

  it("ignores a job whose payment is already terminal or missing", async () => {
    const context = await seed();
    await context.service.transition(
      PAYMENT_ID,
      { status: "CANCELLED" },
      "demo",
    );
    const gateway = context.gateway as ScriptedGateway;
    await context.processor.process(PAYMENT_ID);
    await context.processor.process("3fa85f64-5717-4562-b3fc-2c963f66af99");
    expect(gateway.calls).toHaveLength(0);
    expect((await context.repository.findById(PAYMENT_ID))?.status).toBe(
      "CANCELLED",
    );
  });

  it("does not call the gateway while a processing lease is held", async () => {
    const context = await seed();
    await context.processor.process(PAYMENT_ID);
    const succeeded = await context.repository.findById(PAYMENT_ID);
    if (!succeeded) {
      throw new Error("missing");
    }
    await context.repository.withTransaction(async (tx) => {
      await tx.update(
        {
          ...succeeded,
          status: "PROCESSING",
          processingStartedAt: context.clock.now().toISOString(),
          version: succeeded.version + 1,
        },
        succeeded.version,
      );
    });
    const before = await context.repository.findById(PAYMENT_ID);
    await context.processor.process(PAYMENT_ID);
    expect(await context.repository.findById(PAYMENT_ID)).toEqual(before);
  });

  it("reclaims an expired processing lease without incrementing attempts", async () => {
    const context = build({ steps: ["ok"], leaseMs: 1_000 });
    await context.service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    const created = await context.repository.findById(PAYMENT_ID);
    if (!created) {
      throw new Error("missing");
    }
    await context.repository.withTransaction(async (tx) => {
      await tx.update(
        {
          ...created,
          status: "PROCESSING",
          attempts: 1,
          version: 2,
          processingStartedAt: "2026-01-15T11:00:00.000Z",
        },
        created.version,
      );
    });
    await context.processor.process(PAYMENT_ID);
    expect(await context.repository.findById(PAYMENT_ID)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
    });
  });

  it("leaves the row alone when the version changes during the gateway call", async () => {
    const context = build();
    await context.service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    const processor = new PaymentProcessor({
      repository: context.repository,
      gateway: {
        async charge() {
          await context.repository.withTransaction(async (tx) => {
            const latest = await tx.findByIdForUpdate(PAYMENT_ID);
            if (!latest) {
              throw new Error("missing");
            }
            await tx.update(
              { ...latest, description: "bumped", version: latest.version + 1 },
              latest.version,
            );
          });
          return { approved: true };
        },
      },
      queue: context.queue,
      clock: context.clock,
      random: () => 0,
      logger: context.logger,
      maxAttempts: 3,
      leaseMs: 5_000,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      gatewayTimeoutMs: 1_000,
    });
    await processor.process(PAYMENT_ID);
    const payment = await context.repository.findById(PAYMENT_ID);
    expect(payment?.status).toBe("PROCESSING");
    expect(payment?.description).toBe("bumped");
  });

  it("logs and swallows an unexpected repository failure", async () => {
    const context = build();
    jest
      .spyOn(context.repository, "withTransaction")
      .mockRejectedValueOnce(new Error("db down"));
    await expect(
      context.processor.process(PAYMENT_ID),
    ).resolves.toBeUndefined();
    expect(
      context.logger.entries.some(
        (entry) => entry.msg === "payment processing failed",
      ),
    ).toBe(true);
  });

  it("does not schedule a retry when the release write loses the version", async () => {
    const context = build();
    await context.service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    context.queue.jobs.length = 0;
    const processor = new PaymentProcessor({
      repository: context.repository,
      gateway: {
        async charge() {
          await context.repository.withTransaction(async (tx) => {
            const latest = await tx.findByIdForUpdate(PAYMENT_ID);
            if (!latest) {
              throw new Error("missing");
            }
            await tx.update(
              {
                ...latest,
                description: "changed",
                version: latest.version + 1,
              },
              latest.version,
            );
          });
          throw new GatewayUnavailableError();
        },
      },
      queue: context.queue,
      clock: context.clock,
      random: () => 0,
      logger: context.logger,
      maxAttempts: 3,
      leaseMs: 5_000,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      gatewayTimeoutMs: 1_000,
    });
    await processor.process(PAYMENT_ID);
    expect(context.queue.jobs).toHaveLength(0);
    expect((await context.repository.findById(PAYMENT_ID))?.status).toBe(
      "PROCESSING",
    );
  });

  it("re-enqueues pending payments and expired processing leases", async () => {
    const context = await seed();
    const recovered = await context.processor.recover();
    expect(recovered).toBe(1);
    expect(context.queue.jobs.map((job) => job.paymentId)).toEqual([
      PAYMENT_ID,
    ]);
  });
});
