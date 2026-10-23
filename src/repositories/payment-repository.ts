import type { Payment } from "../domain/payment";
import type { PaymentStatus } from "../domain/payment-state-machine";

export interface IdempotencyRecord {
  clientId: string;
  key: string;
  requestHash: string;
  paymentId: string;
  responseStatus: number;
  responseBody: Payment;
  createdAt: string;
}

export interface ListPaymentsQuery {
  clientId: string;
  status?: PaymentStatus | undefined;
  limit: number;
  offset: number;
}

export interface ListPaymentsResult {
  items: Payment[];
  total: number;
}

export interface PaymentRepository {
  withTransaction<T>(work: (tx: PaymentRepository) => Promise<T>): Promise<T>;
  insert(payment: Payment, idempotency: IdempotencyRecord): Promise<void>;
  findById(id: string): Promise<Payment | null>;
  findByIdForUpdate(id: string): Promise<Payment | null>;
  findByIdempotencyKey(
    clientId: string,
    key: string,
  ): Promise<IdempotencyRecord | null>;
  update(payment: Payment, expectedVersion: number): Promise<Payment>;
  list(query: ListPaymentsQuery): Promise<ListPaymentsResult>;
  listRecoverable(nowIso: string, leaseMs: number): Promise<Payment[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
