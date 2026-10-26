import { ValidationError } from "./errors";
import { assertAmount, isCurrency, type Currency } from "./money";
import {
  assertCanTransition,
  type ClientStatus,
  type PaymentStatus,
} from "./payment-state-machine";

export const PAYMENT_METHOD_TYPES = [
  "card",
  "bank_transfer",
  "wallet",
] as const;

export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

export const FAILURE_REASONS = [
  "GATEWAY_TIMEOUT",
  "GATEWAY_UNAVAILABLE",
  "PAYMENT_DECLINED",
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface MaskedPaymentMethod {
  type: PaymentMethodType;
  last4: string;
}

export type MetadataValue = string | number | boolean;

export type Metadata = Record<string, MetadataValue>;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const METHOD_SET: ReadonlySet<string> = new Set(PAYMENT_METHOD_TYPES);

export interface Payment {
  id: string;
  clientId: string;
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  description: string | null;
  metadata: Metadata;
  idempotencyKey: string;
  paymentMethod: MaskedPaymentMethod;
  statusReason: string | null;
  failureReason: FailureReason | null;
  attempts: number;
  version: number;
  processingStartedAt: string | null;
  /** When a released retry becomes due. Recovery leaves the payment alone until then. */
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewPaymentInput {
  id: string;
  clientId: string;
  amount: number;
  currency: string;
  description?: string | undefined;
  metadata?: Metadata | undefined;
  idempotencyKey: string;
  paymentMethod: { type: string; token: string };
  now: Date;
}

export interface ClientTransition {
  status: ClientStatus;
  reason?: string | undefined;
}

export function createPayment(input: NewPaymentInput): Payment {
  assertAmount(input.amount);
  if (!isCurrency(input.currency)) {
    throw new ValidationError(`Unsupported currency: ${input.currency}`);
  }
  if (!isPaymentMethodType(input.paymentMethod.type)) {
    throw new ValidationError("Unsupported payment method");
  }
  if (!TOKEN_PATTERN.test(input.paymentMethod.token)) {
    throw new ValidationError("Invalid payment method token");
  }
  if (/^\d{13,19}$/.test(input.paymentMethod.token)) {
    throw new ValidationError("Raw card numbers are not accepted");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.clientId)) {
    throw new ValidationError("Invalid API client");
  }
  const timestamp = input.now.toISOString();
  return {
    id: input.id,
    clientId: input.clientId,
    amount: input.amount,
    currency: input.currency,
    status: "PENDING",
    description: input.description ?? null,
    metadata: copyMetadata(input.metadata ?? {}),
    idempotencyKey: input.idempotencyKey,
    paymentMethod: {
      type: input.paymentMethod.type,
      last4: input.paymentMethod.token.slice(-4),
    },
    statusReason: null,
    failureReason: null,
    attempts: 0,
    version: 1,
    processingStartedAt: null,
    nextAttemptAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function applyClientTransition(
  payment: Payment,
  command: ClientTransition,
  now: Date,
): Payment {
  assertCanTransition(payment.status, command.status);
  return {
    ...payment,
    status: command.status,
    statusReason: command.reason ?? null,
    metadata: copyMetadata(payment.metadata),
    version: payment.version + 1,
    updatedAt: now.toISOString(),
  };
}

export function claimForProcessing(payment: Payment, now: Date): Payment {
  assertCanTransition(payment.status, "PROCESSING");
  const timestamp = now.toISOString();
  return {
    ...payment,
    status: "PROCESSING",
    attempts: payment.attempts + 1,
    metadata: copyMetadata(payment.metadata),
    version: payment.version + 1,
    processingStartedAt: timestamp,
    nextAttemptAt: null,
    updatedAt: timestamp,
  };
}

/** Refresh a crashed in-flight attempt. The attempt number stays the same. */
export function reclaimProcessing(payment: Payment, now: Date): Payment {
  if (payment.status !== "PROCESSING") {
    throw new ValidationError("Only a PROCESSING payment can be reclaimed");
  }
  const timestamp = now.toISOString();
  return {
    ...payment,
    metadata: copyMetadata(payment.metadata),
    version: payment.version + 1,
    processingStartedAt: timestamp,
    updatedAt: timestamp,
  };
}

export function markSucceeded(payment: Payment, now: Date): Payment {
  assertCanTransition(payment.status, "SUCCEEDED");
  return {
    ...payment,
    status: "SUCCEEDED",
    failureReason: null,
    metadata: copyMetadata(payment.metadata),
    version: payment.version + 1,
    processingStartedAt: null,
    updatedAt: now.toISOString(),
  };
}

export function markFailed(
  payment: Payment,
  reason: FailureReason,
  now: Date,
): Payment {
  assertCanTransition(payment.status, "FAILED");
  return {
    ...payment,
    status: "FAILED",
    failureReason: reason,
    metadata: copyMetadata(payment.metadata),
    version: payment.version + 1,
    processingStartedAt: null,
    updatedAt: now.toISOString(),
  };
}

export function releaseForRetry(
  payment: Payment,
  now: Date,
  retryAt: Date,
): Payment {
  assertCanTransition(payment.status, "PENDING");
  return {
    ...payment,
    status: "PENDING",
    metadata: copyMetadata(payment.metadata),
    version: payment.version + 1,
    processingStartedAt: null,
    nextAttemptAt: retryAt.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function copyMetadata(metadata: Metadata): Metadata {
  const copy: Metadata = Object.create(null) as Metadata;
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    copy[key] = value;
  }
  return copy;
}

export function isPaymentMethodType(value: string): value is PaymentMethodType {
  return METHOD_SET.has(value);
}

export function leaseExpired(
  payment: Payment,
  now: Date,
  leaseMs: number,
): boolean {
  if (payment.status !== "PROCESSING") {
    return false;
  }
  if (!payment.processingStartedAt) {
    return true;
  }
  return now.getTime() - Date.parse(payment.processingStartedAt) >= leaseMs;
}
