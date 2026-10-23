import { InvalidTransitionError } from "./errors";

export const PAYMENT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "REFUNDED",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const CLIENT_STATUSES = ["CANCELLED", "REFUNDED"] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/**
 * Worker edges: PENDING → PROCESSING → SUCCEEDED | FAILED, and PROCESSING → PENDING
 * while a retry is waiting. Client edges: PENDING → CANCELLED and SUCCEEDED → REFUNDED.
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SUCCEEDED", "FAILED", "PENDING"],
  SUCCEEDED: ["REFUNDED"],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertCanTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/** Statuses with no outgoing edge. SUCCEEDED can still be refunded. */
export function isTerminal(status: PaymentStatus): boolean {
  return status === "FAILED" || status === "CANCELLED" || status === "REFUNDED";
}

export function isClientStatus(status: string): status is ClientStatus {
  return (CLIENT_STATUSES as readonly string[]).includes(status);
}
