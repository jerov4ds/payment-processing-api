import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { ValidationError } from "../domain/errors";
import { MAX_AMOUNT, MIN_AMOUNT, CURRENCIES } from "../domain/money";
import { FAILURE_REASONS, PAYMENT_METHOD_TYPES } from "../domain/payment";
import { PAYMENT_STATUSES } from "../domain/payment-state-machine";

extendZodWithOpenApi(z);

const FORBIDDEN_METADATA_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const metadataSchema = z
  .record(
    z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    z.union([z.string().max(256), z.number().int(), z.boolean()]),
  )
  .superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length > 20) {
      ctx.addIssue({
        code: "custom",
        message: "metadata supports at most 20 keys",
      });
    }
    for (const key of keys) {
      if (FORBIDDEN_METADATA_KEYS.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `metadata key ${key} is not allowed`,
        });
      }
    }
  });

export const createPaymentSchema = z
  .object({
    amount: z.number().int().min(MIN_AMOUNT).max(MAX_AMOUNT),
    currency: z.enum(CURRENCIES),
    description: z.string().min(1).max(255).optional(),
    paymentMethod: z.object({
      type: z.enum(PAYMENT_METHOD_TYPES),
      token: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
    }),
    metadata: metadataSchema.optional(),
  })
  .openapi("CreatePaymentRequest");

export const updateStatusSchema = z
  .object({
    status: z.enum(["CANCELLED", "REFUNDED"]),
    reason: z.string().min(1).max(255).optional(),
  })
  .openapi("UpdatePaymentStatusRequest");

export const publicPaymentSchema = z
  .object({
    id: z.string().uuid(),
    clientId: z.string(),
    amount: z.number().int(),
    currency: z.enum(CURRENCIES),
    status: z.enum(PAYMENT_STATUSES),
    description: z.string().nullable(),
    metadata: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
    paymentMethod: z.object({
      type: z.enum(PAYMENT_METHOD_TYPES),
      last4: z.string(),
    }),
    idempotencyKey: z.string(),
    statusReason: z.string().nullable(),
    failureReason: z.enum(FAILURE_REASONS).nullable(),
    attempts: z.number().int(),
    version: z.number().int(),
    processingStartedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Payment");

export const paymentListSchema = z
  .object({
    data: z.array(publicPaymentSchema),
    page: z.object({
      limit: z.number().int(),
      offset: z.number().int(),
      total: z.number().int(),
    }),
  })
  .openapi("PaymentList");

export const listPaymentsQuerySchema = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    instance: z.string(),
    code: z.string(),
    requestId: z.string(),
    errors: z
      .array(
        z.object({
          path: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  })
  .openapi("Problem");

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError("Request validation failed", {
      errors: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
