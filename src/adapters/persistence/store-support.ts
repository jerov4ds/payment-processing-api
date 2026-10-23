import {
  IdempotencyKeyExistsError,
  VersionConflictError,
} from "../../domain/errors";
import { leaseExpired, type Payment } from "../../domain/payment";
import type { PaymentStatus } from "../../domain/payment-state-machine";
import type {
  IdempotencyRecord,
  ListPaymentsQuery,
  ListPaymentsResult,
} from "../../repositories/payment-repository";

export interface StoreSnapshot {
  payments: Payment[];
  idempotencyKeys: IdempotencyRecord[];
}

export function cloneState<T>(value: T): T {
  return structuredClone(value);
}

export function idempotencyMapKey(clientId: string, key: string): string {
  return `${clientId}\u0000${key}`;
}

export function assertExpectedVersion(
  payment: Payment,
  expectedVersion: number,
): void {
  if (payment.version !== expectedVersion + 1) {
    throw new Error("Updated payment version must increment by exactly 1");
  }
}

export function insertInto(
  state: StoreSnapshot,
  payment: Payment,
  idempotency: IdempotencyRecord,
): void {
  if (payment.clientId !== idempotency.clientId) {
    throw new Error("Payment client does not match the idempotency record");
  }
  if (state.payments.some((existing) => existing.id === payment.id)) {
    throw new Error(`Payment id already exists: ${payment.id}`);
  }
  if (
    state.idempotencyKeys.some(
      (existing) =>
        existing.clientId === idempotency.clientId &&
        existing.key === idempotency.key,
    )
  ) {
    throw new IdempotencyKeyExistsError(idempotency.clientId, idempotency.key);
  }
  state.payments.push(cloneState(payment));
  state.idempotencyKeys.push(cloneState(idempotency));
}

export function updateIn(
  state: StoreSnapshot,
  payment: Payment,
  expectedVersion: number,
): Payment {
  assertExpectedVersion(payment, expectedVersion);
  const index = state.payments.findIndex(
    (existing) => existing.id === payment.id,
  );
  const current = index >= 0 ? state.payments[index] : undefined;
  if (!current) {
    throw new Error(`Payment id was not found: ${payment.id}`);
  }
  if (current.version !== expectedVersion) {
    throw new VersionConflictError();
  }
  if (current.clientId !== payment.clientId) {
    throw new Error("Payment client cannot change");
  }
  const stored = cloneState(payment);
  state.payments[index] = stored;
  return cloneState(stored);
}

export function listFrom(
  state: StoreSnapshot,
  query: ListPaymentsQuery,
): ListPaymentsResult {
  const filtered = state.payments
    .filter((payment) => payment.clientId === query.clientId)
    .filter((payment) =>
      query.status === undefined ? true : payment.status === query.status,
    )
    .slice()
    .sort(comparePayments);
  return {
    total: filtered.length,
    items: filtered
      .slice(query.offset, query.offset + query.limit)
      .map((payment) => cloneState(payment)),
  };
}

export function recoverableFrom(
  state: StoreSnapshot,
  nowIso: string,
  leaseMs: number,
): Payment[] {
  const now = new Date(nowIso);
  return state.payments
    .filter((payment) => isRecoverable(payment, now, leaseMs))
    .map((payment) => cloneState(payment));
}

export function isRecoverable(
  payment: Payment,
  now: Date,
  leaseMs: number,
): boolean {
  if (payment.status === "PENDING") {
    return true;
  }
  return leaseExpired(payment, now, leaseMs);
}

function comparePayments(left: Payment, right: Payment): number {
  const byTime = right.createdAt.localeCompare(left.createdAt);
  if (byTime !== 0) {
    return byTime;
  }
  return left.id.localeCompare(right.id);
}

export function findPayment(state: StoreSnapshot, id: string): Payment | null {
  const payment = state.payments.find((existing) => existing.id === id);
  return payment ? cloneState(payment) : null;
}

export function findIdempotency(
  state: StoreSnapshot,
  clientId: string,
  key: string,
): IdempotencyRecord | null {
  const record = state.idempotencyKeys.find(
    (existing) => existing.clientId === clientId && existing.key === key,
  );
  return record ? cloneState(record) : null;
}

export function emptySnapshot(): StoreSnapshot {
  return { payments: [], idempotencyKeys: [] };
}

export const RECOVERABLE_STATUSES: readonly PaymentStatus[] = [
  "PENDING",
  "PROCESSING",
];
