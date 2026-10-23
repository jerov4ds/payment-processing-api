import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import type { Logger } from "pino";
import type { Env } from "./config/env";
import { RouteNotFoundError } from "./domain/errors";
import { toProblem } from "./http/problem";
import { buildOpenApiSpec } from "./openapi/spec";
import { apiKeyAuth } from "./middleware/auth";
import { denyFraming } from "./middleware/frame-guard";
import { errorHandler } from "./middleware/error-handler";
import { createRateLimiter } from "./middleware/rate-limit";
import { requestId } from "./middleware/request-id";
import { requireJson } from "./middleware/require-json";
import {
  rejectWhenShuttingDown,
  type Readiness,
} from "./middleware/shutdown-gate";
import type { AppLogger } from "./ports/logger";
import type { PaymentRepository } from "./repositories/payment-repository";
import { consoleRouter } from "./routes/console";
import { docsRouter } from "./routes/docs";
import { healthRouter } from "./routes/health";
import { paymentRouter } from "./routes/payments";
import type { PaymentService } from "./services/payment-service";

export interface AppDependencies {
  env: Env;
  logger: AppLogger & Logger;
  paymentService: PaymentService;
  repository: PaymentRepository;
  readiness: Readiness;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req) => {
        const incoming = req as { requestId?: string };
        return incoming.requestId ?? "unknown";
      },
      customProps: (req) => ({
        requestId: (req as { requestId?: string }).requestId,
      }),
    }),
  );
  app.use(rejectWhenShuttingDown(deps.readiness));
  app.use("/api", helmet({ frameguard: { action: "deny" } }));
  app.use("/health", helmet({ frameguard: { action: "deny" } }));
  app.use(denyFraming);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          callback(null, false);
          return;
        }
        callback(null, deps.env.corsOrigins.includes(origin));
      },
      maxAge: 600,
    }),
  );
  app.use(createRateLimiter(deps.env));
  app.use(requireJson);
  app.use(express.json({ limit: deps.env.bodyLimitBytes, strict: true }));
  app.use("/health", healthRouter(deps.repository, deps.readiness));
  app.use("/api", apiKeyAuth(deps.env.apiClients));
  app.use("/api/v1", paymentRouter(deps.paymentService));
  app.use(consoleRouter());
  app.use(docsRouter(buildOpenApiSpec()));
  app.use((req, res) => {
    const problem = toProblem(new RouteNotFoundError(req.method, req.path), {
      requestId: req.requestId ?? "unknown",
      instance: req.originalUrl,
      problemBaseUri: deps.env.problemBaseUri,
    });
    res.status(problem.status).type("application/problem+json").json(problem);
  });
  app.use(errorHandler(deps.env, deps.logger));
  return app;
}
