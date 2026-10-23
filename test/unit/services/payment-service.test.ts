import { MemoryPaymentRepository } from "../../../src/adapters/persistence/memory-payment-repository";
import { sha256Canonical } from "../../../src/domain/canonical-json";
import {
  IdempotencyKeyExistsError,
  IdempotencyMismatchError,
  InvalidTransitionError,
  PaymentNotFoundError,
  VersionConflictError,
} from "../../../src/domain/errors";
import type { IdempotencyRecord } from "../../../src/repositories/payment-repository";
import { PaymentService } from "../../../src/services/payment-service";
import {
  FakeClock,
  PAYMENT_ID,
  RecordingQueue,
  ThrowingQueue,
  createMockLogger,
} from "../../helpers/fixtures";

const input = {
  amount: 150000,
  currency: "NGN" as const,
  description: "Order 1042",
  paymentMethod: { type: "card", token: "tok_visa_4242" },
  metadata: { orderId: "1042" },
};

describe("payment service", () => {
  function build(queue = new RecordingQueue()) {
    const repository = new MemoryPaymentRepository();
    const clock = new FakeClock();
    const logger = createMockLogger();
    let sequence = 0;
    const service = new PaymentService({
      repository,
      queue,
      clock,
      ids: {
        uuid: () => {
          sequence += 1;
          return sequence === 1
            ? PAYMENT_ID
            : `3fa85f64-5717-4562-b3fc-2c963f66af${sequence.toString(16).padStart(2, "0")}`;
        },
      },
      logger,
    });
    return { service, repository, queue, clock, logger };
  }

  it("creates a pending payment, enqueues it, and replays the original snapshot", async () => {
    const { service, queue, repository } = build();
    const created = await service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    expect(created).toMatchObject({
      statusCode: 202,
      replay: false,
      paymentId: PAYMENT_ID,
    });
    expect(created.body.status).toBe("PENDING");
    expect(created.body.paymentMethod).toEqual({ type: "card", last4: "4242" });
    expect(queue.jobs).toHaveLength(1);

    await repository.withTransaction(async (tx) => {
      const current = await tx.findByIdForUpdate(PAYMENT_ID);
      if (!current) {
        throw new Error("missing");
      }
      await tx.update(
        {
          ...current,
          status: "SUCCEEDED",
          version: current.version + 1,
          updatedAt: current.updatedAt,
        },
        current.version,
      );
    });

    const replay = await service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    expect(replay.replay).toBe(true);
    expect(replay.body.status).toBe("PENDING");
    expect(queue.jobs).toHaveLength(1);
    expect((await service.get(PAYMENT_ID, "demo")).status).toBe("SUCCEEDED");
  });

  it("rejects the same key with a different body and still returns 202 if enqueue fails", async () => {
    const { service } = build();
    await service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    await expect(
      service.create(
        { ...input, amount: 200 },
        { clientId: "demo", idempotencyKey: "order-1042-key" },
      ),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);

    const throwing = build(new ThrowingQueue());
    const created = await throwing.service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    expect(created.statusCode).toBe(202);
    expect(
      throwing.logger.entries.some((entry) => entry.level === "error"),
    ).toBe(true);
  });

  it("cancels a pending payment and refunds a succeeded one", async () => {
    const { service, repository } = build();
    await service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    const cancelled = await service.transition(
      PAYMENT_ID,
      { status: "CANCELLED", reason: "changed mind" },
      "demo",
      1,
    );
    expect(cancelled).toMatchObject({
      status: "CANCELLED",
      statusReason: "changed mind",
      version: 2,
    });

    const second = await service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-2-key",
    });
    await repository.withTransaction(async (tx) => {
      const current = await tx.findByIdForUpdate(second.paymentId);
      if (!current) {
        throw new Error("missing");
      }
      await tx.update(
        { ...current, status: "SUCCEEDED", version: current.version + 1 },
        current.version,
      );
    });
    const refunded = await service.transition(
      second.paymentId,
      { status: "REFUNDED" },
      "demo",
    );
    expect(refunded.status).toBe("REFUNDED");
    await expect(
      service.transition(PAYMENT_ID, { status: "REFUNDED" }, "demo"),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(
      service.transition(second.paymentId, { status: "REFUNDED" }, "demo", 1),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("resolves an idempotency insert race from the stored record", async () => {
    const repository = new MemoryPaymentRepository();
    const record: IdempotencyRecord = {
      clientId: "demo",
      key: "order-1042-key",
      requestHash: sha256Canonical(input),
      paymentId: PAYMENT_ID,
      responseStatus: 202,
      responseBody: {
        id: PAYMENT_ID,
        clientId: "demo",
        amount: input.amount,
        currency: "NGN",
        status: "PENDING",
        description: input.description ?? null,
        metadata: input.metadata ?? {},
        idempotencyKey: "order-1042-key",
        paymentMethod: { type: "card", last4: "4242" },
        statusReason: null,
        failureReason: null,
        attempts: 0,
        version: 1,
        processingStartedAt: null,
        createdAt: "2026-01-15T12:00:00.000Z",
        updatedAt: "2026-01-15T12:00:00.000Z",
      },
      createdAt: "2026-01-15T12:00:00.000Z",
    };
    let lookups = 0;
    repository.findByIdempotencyKey = async () => {
      lookups += 1;
      return lookups === 1 ? null : record;
    };
    repository.insert = async () => {
      throw new IdempotencyKeyExistsError("demo", "order-1042-key");
    };
    const racing = new PaymentService({
      repository,
      queue: new RecordingQueue(),
      clock: new FakeClock(),
      ids: { uuid: () => PAYMENT_ID },
      logger: createMockLogger(),
    });
    const replay = await racing.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    expect(replay.replay).toBe(true);
    expect(replay.paymentId).toBe(PAYMENT_ID);

    repository.findByIdempotencyKey = async () => null;
    await expect(
      racing.create(
        { ...input, amount: 200 },
        { clientId: "demo", idempotencyKey: "order-1042-key" },
      ),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);

    repository.findByIdempotencyKey = async () => ({
      ...record,
      requestHash: "different",
    });
    await expect(
      racing.create(input, {
        clientId: "demo",
        idempotencyKey: "order-1042-key",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  it("treats a raced insert whose stored body differs as a mismatch", async () => {
    const repository = new MemoryPaymentRepository();
    const stored: IdempotencyRecord = {
      clientId: "demo",
      key: "order-1042-key",
      requestHash: "different",
      paymentId: PAYMENT_ID,
      responseStatus: 202,
      responseBody: {
        id: PAYMENT_ID,
        clientId: "demo",
        amount: input.amount,
        currency: "NGN",
        status: "PENDING",
        description: input.description ?? null,
        metadata: input.metadata ?? {},
        idempotencyKey: "order-1042-key",
        paymentMethod: { type: "card", last4: "4242" },
        statusReason: null,
        failureReason: null,
        attempts: 0,
        version: 1,
        processingStartedAt: null,
        createdAt: "2026-01-15T12:00:00.000Z",
        updatedAt: "2026-01-15T12:00:00.000Z",
      },
      createdAt: "2026-01-15T12:00:00.000Z",
    };
    let lookups = 0;
    repository.findByIdempotencyKey = async () => {
      lookups += 1;
      return lookups === 1 ? null : stored;
    };
    repository.insert = async () => {
      throw new IdempotencyKeyExistsError("demo", "order-1042-key");
    };
    const racing = new PaymentService({
      repository,
      queue: new RecordingQueue(),
      clock: new FakeClock(),
      ids: { uuid: () => PAYMENT_ID },
      logger: createMockLogger(),
    });
    await expect(
      racing.create(input, {
        clientId: "demo",
        idempotencyKey: "order-1042-key",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  it("returns not found for a missing payment", async () => {
    const { service } = build();
    await expect(service.get(PAYMENT_ID, "demo")).rejects.toBeInstanceOf(
      PaymentNotFoundError,
    );
    await expect(
      service.transition(PAYMENT_ID, { status: "CANCELLED" }, "demo"),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it("hides a payment from every other client", async () => {
    const { service } = build();
    const created = await service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    await expect(
      service.get(created.paymentId, "merchant"),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
    await expect(
      service.transition(
        created.paymentId,
        { status: "CANCELLED" },
        "merchant",
      ),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
    const foreign = await service.list({
      clientId: "merchant",
      limit: 10,
      offset: 0,
    });
    expect(foreign.total).toBe(0);
    const own = await service.get(created.paymentId, "demo");
    expect(own.status).toBe("PENDING");
  });

  it("lists payments by status", async () => {
    const { service } = build();
    await service.create(input, {
      clientId: "demo",
      idempotencyKey: "order-1042-key",
    });
    const page = await service.list({
      clientId: "demo",
      status: "PENDING",
      limit: 10,
      offset: 0,
    });
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe(PAYMENT_ID);
  });
});
