import type { Express } from "express";
import { createLogger } from "../../src/adapters/logging/logger";
import { createApp } from "../../src/app";
import { loadEnv } from "../../src/config/env";
import {
  createContainer,
  type Container,
} from "../../src/composition/create-container";
import type { PaymentGateway } from "../../src/ports/payment-gateway";
import type { PaymentRepository } from "../../src/repositories/payment-repository";
import type { Readiness } from "../../src/middleware/shutdown-gate";

export interface TestApp {
  app: Express;
  container: Container;
  readiness: Readiness;
  apiKey: string;
}

export async function createTestApp(options?: {
  env?: Record<string, string>;
  gateway?: PaymentGateway;
  repository?: PaymentRepository;
  random?: () => number;
  startQueue?: boolean;
}): Promise<TestApp> {
  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    API_KEYS: "demo:test-key-1,merchant:merchant-key",
    REPOSITORY_DRIVER: "memory",
    CORS_ORIGINS: "https://merchant.example",
    GATEWAY_MIN_LATENCY_MS: "0",
    GATEWAY_MAX_LATENCY_MS: "0",
    GATEWAY_TIMEOUT_MS: "1000",
    PAYMENT_MAX_ATTEMPTS: "3",
    RETRY_BASE_DELAY_MS: "0",
    RETRY_MAX_DELAY_MS: "0",
    RATE_LIMIT_MAX: "1000",
    WORKER_CONCURRENCY: "2",
    PROCESSING_LEASE_MS: "5000",
    ...options?.env,
  });
  const logger = createLogger(env.logLevel);
  const container = await createContainer(env, logger, {
    gateway: options?.gateway,
    repository: options?.repository,
    random: options?.random ?? (() => 0),
  });
  const readiness: Readiness = { shuttingDown: false };
  if (options?.startQueue) {
    container.queue.start((paymentId) =>
      container.processor.process(paymentId),
    );
  }
  const app = createApp({
    env,
    logger,
    paymentService: container.paymentService,
    repository: container.repository,
    readiness,
  });
  return { app, container, readiness, apiKey: "test-key-1" };
}
