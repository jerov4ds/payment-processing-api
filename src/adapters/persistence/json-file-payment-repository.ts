import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  StorageCorruptError,
  StorageUnavailableError,
} from "../../domain/errors";
import {
  FAILURE_REASONS,
  PAYMENT_METHOD_TYPES,
  type Payment,
} from "../../domain/payment";
import { CURRENCIES } from "../../domain/money";
import { PAYMENT_STATUSES } from "../../domain/payment-state-machine";
import type { AppLogger } from "../../ports/logger";
import type {
  IdempotencyRecord,
  ListPaymentsQuery,
  ListPaymentsResult,
  PaymentRepository,
} from "../../repositories/payment-repository";
import { atomicWriteFile } from "./atomic-write";
import { Mutex } from "./mutex";
import {
  cloneState,
  emptySnapshot,
  findIdempotency,
  findPayment,
  insertInto,
  listFrom,
  recoverableFrom,
  updateIn,
  type StoreSnapshot,
} from "./store-support";

const metadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

const paymentSchema = z.object({
  id: z.string().uuid(),
  amount: z.number().int().positive(),
  currency: z.enum(CURRENCIES),
  status: z.enum(PAYMENT_STATUSES),
  description: z.string().nullable(),
  metadata: metadataSchema,
  idempotencyKey: z.string(),
  paymentMethod: z.object({
    type: z.enum(PAYMENT_METHOD_TYPES),
    last4: z.string().length(4),
  }),
  statusReason: z.string().nullable(),
  failureReason: z.enum(FAILURE_REASONS).nullable(),
  attempts: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  processingStartedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const idempotencySchema = z.object({
  clientId: z.string(),
  key: z.string(),
  requestHash: z.string(),
  paymentId: z.string().uuid(),
  responseStatus: z.number().int(),
  responseBody: paymentSchema,
  createdAt: z.string(),
});

const documentSchema = z.object({
  schemaVersion: z.literal(1),
  payments: z.array(paymentSchema),
  idempotencyKeys: z.array(idempotencySchema),
});

interface StoreDocument {
  schemaVersion: 1;
  payments: Payment[];
  idempotencyKeys: IdempotencyRecord[];
}

export class JsonFilePaymentRepository implements PaymentRepository {
  private document: StoreDocument = {
    schemaVersion: 1,
    ...emptySnapshot(),
  };
  private readonly mutex = new Mutex();
  private txDepth = 0;
  private ready = false;

  constructor(
    private readonly filePath: string,
    private readonly logger: AppLogger,
  ) {}

  async init(): Promise<void> {
    const directory = path.dirname(this.filePath);
    try {
      await access(directory);
    } catch {
      throw new StorageUnavailableError(
        `Payment store directory does not exist: ${directory}. Create it or set JSON_STORE_PATH.`,
      );
    }
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        this.logger.info(
          { path: this.filePath },
          "payment store is missing; creating an empty file",
        );
        this.document = { schemaVersion: 1, ...emptySnapshot() };
        await this.persist();
        this.ready = true;
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      this.logger.error(
        { path: this.filePath, err: error },
        "payment store is not valid JSON",
      );
      throw new StorageCorruptError(this.filePath);
    }
    const result = documentSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.error(
        { path: this.filePath, issues: result.error.issues },
        "payment store failed schema validation",
      );
      throw new StorageCorruptError(this.filePath);
    }
    this.document = result.data;
    this.ready = true;
  }

  async withTransaction<T>(
    work: (tx: PaymentRepository) => Promise<T>,
  ): Promise<T> {
    this.assertReady();
    if (this.txDepth > 0) {
      return work(this);
    }
    return this.mutex.run(async () => {
      const snapshot = cloneState(this.document);
      this.txDepth += 1;
      try {
        const result = await work(this);
        await this.persist();
        return result;
      } catch (error) {
        this.document = snapshot;
        throw error;
      } finally {
        this.txDepth -= 1;
      }
    });
  }

  async insert(
    payment: Payment,
    idempotency: IdempotencyRecord,
  ): Promise<void> {
    await this.exclusive(async () => {
      insertInto(this.snapshot(), payment, idempotency);
      if (this.txDepth === 0) {
        await this.persist();
      }
    });
  }

  findById(id: string): Promise<Payment | null> {
    return this.exclusive(() => findPayment(this.snapshot(), id));
  }

  findByIdForUpdate(id: string): Promise<Payment | null> {
    return this.findById(id);
  }

  findByIdempotencyKey(
    clientId: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    return this.exclusive(() =>
      findIdempotency(this.snapshot(), clientId, key),
    );
  }

  async update(payment: Payment, expectedVersion: number): Promise<Payment> {
    return this.exclusive(async () => {
      const updated = updateIn(this.snapshot(), payment, expectedVersion);
      if (this.txDepth === 0) {
        await this.persist();
      }
      return updated;
    });
  }

  list(query: ListPaymentsQuery): Promise<ListPaymentsResult> {
    return this.exclusive(() => listFrom(this.snapshot(), query));
  }

  listRecoverable(nowIso: string, leaseMs: number): Promise<Payment[]> {
    return this.exclusive(() =>
      recoverableFrom(this.snapshot(), nowIso, leaseMs),
    );
  }

  async ping(): Promise<void> {
    this.assertReady();
    try {
      await access(this.filePath);
    } catch {
      throw new StorageUnavailableError(
        `Payment store is not readable: ${this.filePath}`,
      );
    }
  }

  close(): Promise<void> {
    return this.mutex.run(() => Promise.resolve());
  }

  private snapshot(): StoreSnapshot {
    return this.document;
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new StorageUnavailableError("Payment store is not loaded");
    }
  }

  private exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    this.assertReady();
    if (this.txDepth > 0) {
      return Promise.resolve(operation());
    }
    return this.mutex.run(() => Promise.resolve(operation()));
  }

  private async persist(): Promise<void> {
    const body = `${JSON.stringify(this.document, null, 2)}\n`;
    await atomicWriteFile(this.filePath, body);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
