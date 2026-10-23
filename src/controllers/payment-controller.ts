import type { Request, Response } from "express";
import { z } from "zod";
import {
  MissingIdempotencyKeyError,
  UnauthorizedError,
  ValidationError,
} from "../domain/errors";
import {
  createPaymentSchema,
  listPaymentsQuerySchema,
  parseSchema,
  updateStatusSchema,
} from "../http/schemas";
import type { PaymentService } from "../services/payment-service";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,255}$/;

export function createPaymentController(service: PaymentService) {
  return {
    async create(req: Request, res: Response): Promise<void> {
      const clientId = requireClient(req);
      const idempotencyKey = readIdempotencyKey(req);
      const body = parseSchema(createPaymentSchema, req.body);
      const result = await service.create(
        {
          amount: body.amount,
          currency: body.currency,
          description: body.description,
          metadata: body.metadata,
          paymentMethod: body.paymentMethod,
        },
        { clientId, idempotencyKey },
      );
      res
        .status(result.statusCode)
        .location(`/api/v1/payments/${result.paymentId}`)
        .json(result.body);
    },

    async get(req: Request, res: Response): Promise<void> {
      requireClient(req);
      const id = parseSchema(z.string().uuid(), routeParam(req.params.id));
      const payment = await service.get(id);
      res.status(200).json(payment);
    },

    async list(req: Request, res: Response): Promise<void> {
      requireClient(req);
      const query = parseSchema(listPaymentsQuerySchema, req.query);
      const page = await service.list(query);
      res.status(200).json({
        data: page.items,
        page: {
          limit: query.limit,
          offset: query.offset,
          total: page.total,
        },
      });
    },

    async updateStatus(req: Request, res: Response): Promise<void> {
      requireClient(req);
      const id = parseSchema(z.string().uuid(), routeParam(req.params.id));
      const body = parseSchema(updateStatusSchema, req.body);
      const payment = await service.transition(id, body, readIfMatch(req));
      res.status(200).json(payment);
    },
  };
}

function requireClient(req: Request): string {
  if (!req.clientId) {
    throw new UnauthorizedError();
  }
  return req.clientId;
}

function readIdempotencyKey(req: Request): string {
  const header = req.header("idempotency-key");
  if (!header) {
    throw new MissingIdempotencyKeyError();
  }
  if (!IDEMPOTENCY_KEY.test(header)) {
    throw new ValidationError(
      "Idempotency-Key must be 8-255 characters and contain only letters, numbers, dots, underscores, colons, or hyphens",
    );
  }
  return header;
}

function readIfMatch(req: Request): number | undefined {
  const header = req.header("if-match");
  if (header === undefined) {
    return undefined;
  }
  const token = header.trim().replace(/^"|"$/g, "");
  if (!/^[0-9]+$/.test(token)) {
    throw new ValidationError("If-Match must be a payment version");
  }
  return Number(token);
}

function routeParam(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return "";
}
