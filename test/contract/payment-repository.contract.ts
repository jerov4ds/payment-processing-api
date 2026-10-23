import {
  IdempotencyKeyExistsError,
  VersionConflictError,
} from "../../src/domain/errors";
import type { Payment } from "../../src/domain/payment";
import type {
  IdempotencyRecord,
  PaymentRepository,
} from "../../src/repositories/payment-repository";
import {
  OTHER_PAYMENT_ID,
  PAYMENT_ID,
  samplePayment,
} from "../helpers/fixtures";

export function paymentRepositoryContract(
  label: string,
  setup: () => Promise<{
    repo: PaymentRepository;
    cleanup: () => Promise<void>;
  }>,
): void {
  describe(label, () => {
    let repo: PaymentRepository;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const created = await setup();
      repo = created.repo;
      cleanup = created.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it("inserts a payment and reads it back without sharing mutable state", async () => {
      const payment = samplePayment();
      await repo.withTransaction(async (tx) => {
        await tx.insert(payment, idempotencyFor(payment));
      });
      const loaded = await repo.findById(payment.id);
      expect(loaded).toEqual(payment);
      if (!loaded) {
        throw new Error("expected payment");
      }
      loaded.description = "mutated";
      loaded.metadata.orderId = "changed";
      const again = await repo.findById(payment.id);
      expect(again?.description).toBe("Order 1042");
      expect(again?.metadata.orderId).toBe("1042");
    });

    it("rolls back an insert when the transaction throws", async () => {
      const payment = samplePayment();
      await expect(
        repo.withTransaction(async (tx) => {
          await tx.insert(payment, idempotencyFor(payment));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await repo.findById(payment.id)).toBeNull();
      expect(
        await repo.findByIdempotencyKey("demo", payment.idempotencyKey),
      ).toBeNull();
    });

    it("rejects a duplicate idempotency key", async () => {
      const first = samplePayment();
      const second = samplePayment({
        id: OTHER_PAYMENT_ID,
        idempotencyKey: first.idempotencyKey,
      });
      await repo.withTransaction(async (tx) => {
        await tx.insert(first, idempotencyFor(first));
      });
      await expect(
        repo.withTransaction(async (tx) => {
          await tx.insert(second, idempotencyFor(second, "different-hash"));
        }),
      ).rejects.toBeInstanceOf(IdempotencyKeyExistsError);
      expect(await repo.findById(second.id)).toBeNull();
    });

    it("returns version conflicts for a stale update and keeps the winner", async () => {
      const payment = samplePayment();
      await repo.withTransaction(async (tx) => {
        await tx.insert(payment, idempotencyFor(payment));
      });
      const results = await Promise.allSettled([
        repo.withTransaction(async (tx) =>
          tx.update(bumped(payment, "alpha"), payment.version),
        ),
        repo.withTransaction(async (tx) =>
          tx.update(bumped(payment, "beta"), payment.version),
        ),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        VersionConflictError,
      );
      const stored = await repo.findById(payment.id);
      expect(stored?.version).toBe(2);
      expect(["alpha", "beta"]).toContain(stored?.description);
    });

    it("lists by status with a stable page and finds recoverable rows", async () => {
      const older = samplePayment({
        id: OTHER_PAYMENT_ID,
        createdAt: "2026-01-15T11:00:00.000Z",
        status: "PENDING",
        idempotencyKey: "older-key",
      });
      const newer = samplePayment({
        createdAt: "2026-01-15T12:00:00.000Z",
        status: "PENDING",
      });
      const done = samplePayment({
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa8",
        status: "SUCCEEDED",
        idempotencyKey: "done-key",
        createdAt: "2026-01-15T13:00:00.000Z",
      });
      const inFlight = samplePayment({
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa9",
        status: "PROCESSING",
        idempotencyKey: "flight-key",
        processingStartedAt: "2026-01-15T12:00:28.000Z",
        attempts: 1,
        version: 2,
      });
      const stale = samplePayment({
        id: "3fa85f64-5717-4562-b3fc-2c963f66afaa",
        status: "PROCESSING",
        idempotencyKey: "stale-key",
        processingStartedAt: "2026-01-15T11:00:00.000Z",
        attempts: 1,
        version: 2,
      });
      for (const payment of [older, newer, done, inFlight, stale]) {
        await repo.withTransaction(async (tx) => {
          await tx.insert(payment, idempotencyFor(payment));
        });
      }
      const page = await repo.list({ status: "PENDING", limit: 1, offset: 0 });
      expect(page.total).toBe(2);
      expect(page.items.map((payment) => payment.id)).toEqual([PAYMENT_ID]);
      const recoverable = await repo.listRecoverable(
        "2026-01-15T12:00:30.000Z",
        5_000,
      );
      const ids = recoverable.map((payment) => payment.id).sort();
      expect(ids).toEqual([OTHER_PAYMENT_ID, PAYMENT_ID, stale.id].sort());
    });

    it("answers ping", async () => {
      await expect(repo.ping()).resolves.toBeUndefined();
    });
  });
}

function idempotencyFor(
  payment: Payment,
  requestHash = "hash-1",
): IdempotencyRecord {
  return {
    clientId: "demo",
    key: payment.idempotencyKey,
    requestHash,
    paymentId: payment.id,
    responseStatus: 202,
    responseBody: payment,
    createdAt: payment.createdAt,
  };
}

function bumped(payment: Payment, description: string): Payment {
  return {
    ...payment,
    description,
    version: payment.version + 1,
    updatedAt: "2026-01-15T12:05:00.000Z",
  };
}
