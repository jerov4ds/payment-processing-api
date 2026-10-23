import {
  OpenApiGeneratorV3,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  createPaymentSchema,
  listPaymentsQuerySchema,
  problemSchema,
  publicPaymentSchema,
  updateStatusSchema,
} from "../http/schemas";

const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "ApiKeyAuth", {
  type: "apiKey",
  in: "header",
  name: "X-Api-Key",
});

const jsonProblem = {
  description: "Problem details",
  content: {
    "application/problem+json": {
      schema: problemSchema,
    },
  },
};

registry.registerPath({
  method: "post",
  path: "/api/v1/payments",
  tags: ["Payments"],
  summary: "Create a payment",
  description:
    "Accepts a payment and returns 202 while it is PENDING. Processing continues in the background. Replaying the same Idempotency-Key and body returns the original 202 snapshot.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    headers: z.object({
      "Idempotency-Key": z.string().openapi({
        description: "8-255 characters. Unique per API client.",
      }),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createPaymentSchema,
        },
      },
    },
  },
  responses: {
    "202": {
      description: "Payment accepted",
      content: { "application/json": { schema: publicPaymentSchema } },
    },
    "400": jsonProblem,
    "401": jsonProblem,
    "413": jsonProblem,
    "415": jsonProblem,
    "422": jsonProblem,
    "429": jsonProblem,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/payments/{id}",
  tags: ["Payments"],
  summary: "Get a payment",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    "200": {
      description: "Current payment",
      content: { "application/json": { schema: publicPaymentSchema } },
    },
    "400": jsonProblem,
    "401": jsonProblem,
    "404": jsonProblem,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/payments",
  tags: ["Payments"],
  summary: "List payments",
  security: [{ ApiKeyAuth: [] }],
  request: {
    query: listPaymentsQuerySchema,
  },
  responses: {
    "200": {
      description: "A page of payments",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(publicPaymentSchema),
            page: z.object({
              limit: z.number().int(),
              offset: z.number().int(),
              total: z.number().int(),
            }),
          }),
        },
      },
    },
    "400": jsonProblem,
    "401": jsonProblem,
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/payments/{id}/status",
  tags: ["Payments"],
  summary: "Cancel or refund a payment",
  description:
    "Clients may request CANCELLED from PENDING, or REFUNDED from SUCCEEDED. PROCESSING, SUCCEEDED, and FAILED are written only by the background processor. Send If-Match with the current version to detect a lost update.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    headers: z.object({
      "If-Match": z
        .string()
        .optional()
        .openapi({ description: "Current payment version." }),
    }),
    body: {
      required: true,
      content: { "application/json": { schema: updateStatusSchema } },
    },
  },
  responses: {
    "200": {
      description: "Updated payment",
      content: { "application/json": { schema: publicPaymentSchema } },
    },
    "400": jsonProblem,
    "401": jsonProblem,
    "404": jsonProblem,
    "409": jsonProblem,
  },
});

registry.registerPath({
  method: "get",
  path: "/health/live",
  tags: ["Health"],
  summary: "Liveness probe",
  responses: {
    "200": {
      description: "Process is up",
      content: {
        "application/json": { schema: z.object({ status: z.literal("ok") }) },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/health/ready",
  tags: ["Health"],
  summary: "Readiness probe",
  description: "Checks that the configured payment store can be reached.",
  responses: {
    "200": {
      description: "Ready to serve",
      content: {
        "application/json": { schema: z.object({ status: z.literal("ok") }) },
      },
    },
    "503": jsonProblem,
  },
});

export function buildOpenApiSpec(): object {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Payment Service",
      version: "1.0.0",
      description:
        "Simulated payment processing API. Amounts are integer minor units. Raw card numbers are not accepted.",
    },
    servers: [{ url: "/" }],
  });
}
