import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  IdempotencyKeyExistsError,
  VersionConflictError,
} from "../../domain/errors";
import { CURRENCIES } from "../../domain/money";
import {
  FAILURE_REASONS,
  copyMetadata,
  isPaymentMethodType,
  type FailureReason,
  type Payment,
} from "../../domain/payment";
import {
  PAYMENT_STATUSES,
  type PaymentStatus,
} from "../../domain/payment-state-machine";
import type {
  IdempotencyRecord,
  ListPaymentsQuery,
  ListPaymentsResult,
  PaymentRepository,
} from "../../repositories/payment-repository";

interface PaymentRow extends QueryResultRow {
  id: string;
  api_client_id: string;
  amount: string | number;
  currency: string;
  status: string;
  description: string | null;
  metadata: Record<string, string | number | boolean>;
  idempotency_key: string;
  payment_method: { type: string; last4: string };
  status_reason: string | null;
  failure_reason: string | null;
  attempts: number;
  version: number;
  processing_started_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface IdempotencyRow extends QueryResultRow {
  api_client_id: string;
  idempotency_key: string;
  request_hash: string;
  payment_id: string;
  response_status: number;
  response_body: Payment;
  created_at: Date | string;
}

type Queryable = Pool | PoolClient;

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(
    private readonly pool: Pool,
    private readonly client?: PoolClient,
  ) {}

  async withTransaction<T>(
    work: (tx: PaymentRepository) => Promise<T>,
  ): Promise<T> {
    if (this.client) {
      return work(this);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new PostgresPaymentRepository(this.pool, client);
      const result = await work(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async insert(
    payment: Payment,
    idempotency: IdempotencyRecord,
  ): Promise<void> {
    if (!this.client) {
      await this.withTransaction(async (tx) => tx.insert(payment, idempotency));
      return;
    }
    try {
      if (payment.clientId !== idempotency.clientId) {
        throw new Error("Payment client does not match the idempotency record");
      }
      await this.client.query(
        `INSERT INTO payments (
           id, api_client_id, amount, currency, status, description, metadata,
           idempotency_key, payment_method, status_reason, failure_reason,
           attempts, version, processing_started_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb,
           $8, $9::jsonb, $10, $11,
           $12, $13, $14, $15, $16
         )`,
        paymentParams(payment),
      );
      await this.client.query(
        `INSERT INTO idempotency_keys (
           api_client_id, idempotency_key, request_hash, payment_id,
           response_status, response_body, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          idempotency.clientId,
          idempotency.key,
          idempotency.requestHash,
          idempotency.paymentId,
          idempotency.responseStatus,
          JSON.stringify(idempotency.responseBody),
          new Date(idempotency.createdAt),
        ],
      );
    } catch (error) {
      if (isIdempotencyConflict(error)) {
        throw new IdempotencyKeyExistsError(
          idempotency.clientId,
          idempotency.key,
        );
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Payment | null> {
    const result = await this.query<PaymentRow>(
      "SELECT * FROM payments WHERE id = $1",
      [id],
    );
    return mapPayment(result.rows[0]);
  }

  async findByIdForUpdate(id: string): Promise<Payment | null> {
    const sql = this.client
      ? "SELECT * FROM payments WHERE id = $1 FOR UPDATE"
      : "SELECT * FROM payments WHERE id = $1";
    const result = await this.query<PaymentRow>(sql, [id]);
    return mapPayment(result.rows[0]);
  }

  async findByIdempotencyKey(
    clientId: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const result = await this.query<IdempotencyRow>(
      `SELECT * FROM idempotency_keys
       WHERE api_client_id = $1 AND idempotency_key = $2`,
      [clientId, key],
    );
    return mapIdempotency(result.rows[0]);
  }

  async update(payment: Payment, expectedVersion: number): Promise<Payment> {
    if (payment.version !== expectedVersion + 1) {
      throw new Error("Updated payment version must increment by exactly 1");
    }
    const result = await this.query<PaymentRow>(
      `UPDATE payments SET
         amount = $1,
         currency = $2,
         status = $3,
         description = $4,
         metadata = $5::jsonb,
         idempotency_key = $6,
         payment_method = $7::jsonb,
         status_reason = $8,
         failure_reason = $9,
         attempts = $10,
         version = $11,
         processing_started_at = $12,
         updated_at = $13
       WHERE id = $14 AND version = $15 AND api_client_id = $16
       RETURNING *`,
      [
        payment.amount,
        payment.currency,
        payment.status,
        payment.description,
        JSON.stringify(payment.metadata),
        payment.idempotencyKey,
        JSON.stringify(payment.paymentMethod),
        payment.statusReason,
        payment.failureReason,
        payment.attempts,
        payment.version,
        payment.processingStartedAt
          ? new Date(payment.processingStartedAt)
          : null,
        new Date(payment.updatedAt),
        payment.id,
        expectedVersion,
        payment.clientId,
      ],
    );
    const row = result.rows[0];
    if (row) {
      return mapRequiredPayment(row);
    }
    const existing = await this.findById(payment.id);
    if (!existing) {
      throw new Error(`Payment id was not found: ${payment.id}`);
    }
    if (existing.clientId !== payment.clientId) {
      throw new Error("Payment client cannot change");
    }
    throw new VersionConflictError();
  }

  async list(query: ListPaymentsQuery): Promise<ListPaymentsResult> {
    const status = query.status ?? null;
    const rows = await this.query<PaymentRow>(
      `SELECT * FROM payments
       WHERE api_client_id = $1
         AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC, id ASC
       LIMIT $3 OFFSET $4`,
      [query.clientId, status, query.limit, query.offset],
    );
    const count = await this.query<{ total: string | number }>(
      `SELECT COUNT(*)::int AS total FROM payments
       WHERE api_client_id = $1
         AND ($2::text IS NULL OR status = $2)`,
      [query.clientId, status],
    );
    const totalValue = count.rows[0]?.total ?? 0;
    return {
      total: Number(totalValue),
      items: rows.rows.map((row) => mapRequiredPayment(row)),
    };
  }

  async listRecoverable(nowIso: string, leaseMs: number): Promise<Payment[]> {
    const cutoff = new Date(Date.parse(nowIso) - leaseMs);
    const rows = await this.query<PaymentRow>(
      `SELECT * FROM payments
       WHERE status = 'PENDING'
          OR (
            status = 'PROCESSING'
            AND (processing_started_at IS NULL OR processing_started_at <= $1)
          )`,
      [cutoff],
    );
    return rows.rows.map((row) => mapRequiredPayment(row));
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  async close(): Promise<void> {
    if (this.client) {
      return;
    }
    await this.pool.end();
  }

  private query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const db: Queryable = this.client ?? this.pool;
    return db.query<T>(sql, params);
  }
}

function paymentParams(payment: Payment): unknown[] {
  return [
    payment.id,
    payment.clientId,
    payment.amount,
    payment.currency,
    payment.status,
    payment.description,
    JSON.stringify(payment.metadata),
    payment.idempotencyKey,
    JSON.stringify(payment.paymentMethod),
    payment.statusReason,
    payment.failureReason,
    payment.attempts,
    payment.version,
    payment.processingStartedAt ? new Date(payment.processingStartedAt) : null,
    new Date(payment.createdAt),
    new Date(payment.updatedAt),
  ];
}

function mapPayment(row: PaymentRow | undefined): Payment | null {
  if (!row) {
    return null;
  }
  return mapRequiredPayment(row);
}

function mapRequiredPayment(row: PaymentRow): Payment {
  if (!(CURRENCIES as readonly string[]).includes(row.currency)) {
    throw new Error(`Stored currency is invalid: ${row.currency}`);
  }
  if (!(PAYMENT_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`Stored status is invalid: ${row.status}`);
  }
  if (!isPaymentMethodType(row.payment_method.type)) {
    throw new Error("Stored payment method is invalid");
  }
  const amount =
    typeof row.amount === "string" ? Number(row.amount) : row.amount;
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`Stored amount is not a safe integer: ${row.amount}`);
  }
  const failureReason = row.failure_reason;
  if (
    failureReason !== null &&
    !(FAILURE_REASONS as readonly string[]).includes(failureReason)
  ) {
    throw new Error(`Stored failure reason is invalid: ${failureReason}`);
  }
  return {
    id: row.id,
    clientId: row.api_client_id,
    amount,
    currency: row.currency as Payment["currency"],
    status: row.status as PaymentStatus,
    description: row.description,
    metadata: copyMetadata(row.metadata ?? {}),
    idempotencyKey: row.idempotency_key,
    paymentMethod: {
      type: row.payment_method.type,
      last4: row.payment_method.last4,
    },
    statusReason: row.status_reason,
    failureReason: failureReason as FailureReason | null,
    attempts: row.attempts,
    version: row.version,
    processingStartedAt: toIso(row.processing_started_at),
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
  };
}

function mapIdempotency(
  row: IdempotencyRow | undefined,
): IdempotencyRecord | null {
  if (!row) {
    return null;
  }
  return {
    clientId: row.api_client_id,
    key: row.idempotency_key,
    requestHash: row.request_hash,
    paymentId: row.payment_id,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    createdAt: toIsoRequired(row.created_at),
  };
}

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toIsoRequired(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function isIdempotencyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === "23505" &&
    candidate.constraint === "idempotency_keys_pkey"
  );
}
