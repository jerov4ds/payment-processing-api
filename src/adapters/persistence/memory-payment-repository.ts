import type { Payment } from "../../domain/payment";
import type {
  IdempotencyRecord,
  ListPaymentsQuery,
  ListPaymentsResult,
  PaymentRepository,
} from "../../repositories/payment-repository";
import {
  cloneState,
  emptySnapshot,
  findIdempotency,
  findPayment,
  insertInto,
  listFrom,
  recoverableFrom,
  transactionView,
  updateIn,
  type StoreSnapshot,
} from "./store-support";
import { Mutex } from "./mutex";

export class MemoryPaymentRepository implements PaymentRepository {
  private state: StoreSnapshot = emptySnapshot();
  private readonly mutex = new Mutex();
  private readonly tx = transactionView(() => this.state, this);

  async withTransaction<T>(
    work: (tx: PaymentRepository) => Promise<T>,
  ): Promise<T> {
    return this.mutex.run(async () => {
      const snapshot = cloneState(this.state);
      try {
        return await work(this.tx);
      } catch (error) {
        this.state = snapshot;
        throw error;
      }
    });
  }

  async insert(
    payment: Payment,
    idempotency: IdempotencyRecord,
  ): Promise<void> {
    await this.exclusive(() => {
      insertInto(this.state, payment, idempotency);
    });
  }

  findById(id: string): Promise<Payment | null> {
    return this.exclusive(() => findPayment(this.state, id));
  }

  findByIdForUpdate(id: string): Promise<Payment | null> {
    return this.findById(id);
  }

  findByIdempotencyKey(
    clientId: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    return this.exclusive(() => findIdempotency(this.state, clientId, key));
  }

  update(payment: Payment, expectedVersion: number): Promise<Payment> {
    return this.exclusive(() => updateIn(this.state, payment, expectedVersion));
  }

  list(query: ListPaymentsQuery): Promise<ListPaymentsResult> {
    return this.exclusive(() => listFrom(this.state, query));
  }

  listRecoverable(nowIso: string, leaseMs: number): Promise<Payment[]> {
    return this.exclusive(() => recoverableFrom(this.state, nowIso, leaseMs));
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return this.mutex.run(() => Promise.resolve());
  }

  private exclusive<T>(operation: () => T): Promise<T> {
    return this.mutex.run(() => Promise.resolve(operation()));
  }
}
