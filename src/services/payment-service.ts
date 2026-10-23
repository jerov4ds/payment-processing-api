import { sha256Canonical } from "../domain/canonical-json";
import {
  IdempotencyKeyExistsError,
  IdempotencyMismatchError,
  PaymentNotFoundError,
  VersionConflictError,
} from "../domain/errors";
import {
  applyClientTransition,
  createPayment,
  type ClientTransition,
  type Metadata,
  type Payment,
} from "../domain/payment";
import type { Currency } from "../domain/money";
import type { Clock, IdGenerator } from "../ports/clock";
import type { JobQueue } from "../ports/job-queue";
import type { AppLogger } from "../ports/logger";
import type {
  IdempotencyRecord,
  ListPaymentsQuery,
  ListPaymentsResult,
  PaymentRepository,
} from "../repositories/payment-repository";

export interface CreatePaymentInput {
  amount: number;
  currency: Currency;
  description?: string | undefined;
  metadata?: Metadata | undefined;
  paymentMethod: { type: string; token: string };
}

export interface CreatePaymentContext {
  clientId: string;
  idempotencyKey: string;
}

export interface CreatePaymentResult {
  statusCode: number;
  body: Payment;
  paymentId: string;
  replay: boolean;
}

export interface PaymentServiceDeps {
  repository: PaymentRepository;
  queue: JobQueue;
  clock: Clock;
  ids: IdGenerator;
  logger: AppLogger;
}

export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

  async create(
    input: CreatePaymentInput,
    context: CreatePaymentContext,
  ): Promise<CreatePaymentResult> {
    const requestHash = sha256Canonical(input);
    try {
      const outcome = await this.deps.repository.withTransaction(async (tx) => {
        const existing = await tx.findByIdempotencyKey(
          context.clientId,
          context.idempotencyKey,
        );
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new IdempotencyMismatchError();
          }
          return { kind: "replay" as const, record: existing };
        }
        const payment = createPayment({
          id: this.deps.ids.uuid(),
          clientId: context.clientId,
          amount: input.amount,
          currency: input.currency,
          description: input.description,
          metadata: input.metadata,
          idempotencyKey: context.idempotencyKey,
          paymentMethod: input.paymentMethod,
          now: this.deps.clock.now(),
        });
        const record: IdempotencyRecord = {
          clientId: context.clientId,
          key: context.idempotencyKey,
          requestHash,
          paymentId: payment.id,
          responseStatus: 202,
          responseBody: payment,
          createdAt: payment.createdAt,
        };
        await tx.insert(payment, record);
        return { kind: "created" as const, payment };
      });
      if (outcome.kind === "replay") {
        return {
          statusCode: outcome.record.responseStatus,
          body: outcome.record.responseBody,
          paymentId: outcome.record.paymentId,
          replay: true,
        };
      }
      this.enqueue(outcome.payment.id);
      return {
        statusCode: 202,
        body: outcome.payment,
        paymentId: outcome.payment.id,
        replay: false,
      };
    } catch (error) {
      if (error instanceof IdempotencyKeyExistsError) {
        return this.replayAfterRace(context, requestHash);
      }
      throw error;
    }
  }

  async get(id: string, clientId: string): Promise<Payment> {
    const payment = await this.deps.repository.findById(id);
    if (!payment || payment.clientId !== clientId) {
      throw new PaymentNotFoundError(id);
    }
    return payment;
  }

  async list(query: ListPaymentsQuery): Promise<ListPaymentsResult> {
    return this.deps.repository.list(query);
  }

  async transition(
    id: string,
    command: ClientTransition,
    clientId: string,
    ifMatch?: number,
  ): Promise<Payment> {
    return this.deps.repository.withTransaction(async (tx) => {
      const payment = await tx.findByIdForUpdate(id);
      if (!payment || payment.clientId !== clientId) {
        throw new PaymentNotFoundError(id);
      }
      if (ifMatch !== undefined && payment.version !== ifMatch) {
        throw new VersionConflictError();
      }
      const next = applyClientTransition(
        payment,
        command,
        this.deps.clock.now(),
      );
      return tx.update(next, payment.version);
    });
  }

  private enqueue(paymentId: string): void {
    try {
      this.deps.queue.enqueue({ paymentId, runAt: this.deps.clock.now() });
    } catch (error) {
      this.deps.logger.error(
        { err: error, paymentId },
        "failed to enqueue payment; recovery will retry",
      );
    }
  }

  private async replayAfterRace(
    context: CreatePaymentContext,
    requestHash: string,
  ): Promise<CreatePaymentResult> {
    const existing = await this.deps.repository.findByIdempotencyKey(
      context.clientId,
      context.idempotencyKey,
    );
    if (!existing) {
      throw new IdempotencyMismatchError();
    }
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyMismatchError();
    }
    return {
      statusCode: existing.responseStatus,
      body: existing.responseBody,
      paymentId: existing.paymentId,
      replay: true,
    };
  }
}
