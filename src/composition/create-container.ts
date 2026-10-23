import path from "node:path";
import { Pool } from "pg";
import type { Logger } from "pino";
import { SimulatedPaymentGateway } from "../adapters/gateway/simulated-payment-gateway";
import { createLogger } from "../adapters/logging/logger";
import { JsonFilePaymentRepository } from "../adapters/persistence/json-file-payment-repository";
import { MemoryPaymentRepository } from "../adapters/persistence/memory-payment-repository";
import { applyMigrations } from "../adapters/persistence/migrate";
import { PostgresPaymentRepository } from "../adapters/persistence/postgres-payment-repository";
import { InProcessJobQueue } from "../adapters/queue/in-process-job-queue";
import type { Env } from "../config/env";
import { SystemClock, SystemIds, SystemSleeper } from "../ports/clock";
import type { AppLogger } from "../ports/logger";
import type { PaymentGateway } from "../ports/payment-gateway";
import type { PaymentRepository } from "../repositories/payment-repository";
import { PaymentProcessor } from "../services/payment-processor";
import { PaymentService } from "../services/payment-service";
import { mulberry32 } from "../services/random";

export interface Container {
  env: Env;
  logger: AppLogger & Logger;
  repository: PaymentRepository;
  gateway: PaymentGateway;
  queue: InProcessJobQueue;
  processor: PaymentProcessor;
  paymentService: PaymentService;
  clock: SystemClock;
}

export interface ContainerOverrides {
  gateway?: PaymentGateway;
  repository?: PaymentRepository;
  random?: () => number;
}

export async function createContainer(
  env: Env,
  logger: AppLogger & Logger,
  overrides: ContainerOverrides = {},
): Promise<Container> {
  const clock = new SystemClock();
  const repository =
    overrides.repository ?? (await createRepository(env, logger));
  const gateway =
    overrides.gateway ??
    new SimulatedPaymentGateway({
      seed: env.gatewaySeed,
      minLatencyMs: env.gatewayMinLatencyMs,
      maxLatencyMs: env.gatewayMaxLatencyMs,
      transientFailureRate: env.gatewayTransientFailureRate,
      permanentFailureRate: env.gatewayPermanentFailureRate,
      sleeper: new SystemSleeper(),
    });
  const queue = new InProcessJobQueue(
    clock,
    env.workerConcurrency,
    (error, paymentId) => {
      logger.error({ err: error, paymentId }, "job failed");
    },
  );
  const random = overrides.random ?? mulberry32(env.gatewaySeed);
  const processor = new PaymentProcessor({
    repository,
    gateway,
    queue,
    clock,
    random,
    logger,
    maxAttempts: env.paymentMaxAttempts,
    leaseMs: env.processingLeaseMs,
    retryBaseDelayMs: env.retryBaseDelayMs,
    retryMaxDelayMs: env.retryMaxDelayMs,
    gatewayTimeoutMs: env.gatewayTimeoutMs,
  });
  const paymentService = new PaymentService({
    repository,
    queue,
    clock,
    ids: new SystemIds(),
    logger,
  });
  return {
    env,
    logger,
    repository,
    gateway,
    queue,
    processor,
    paymentService,
    clock,
  };
}

async function createRepository(
  env: Env,
  logger: AppLogger,
): Promise<PaymentRepository> {
  if (env.repositoryDriver === "memory") {
    return new MemoryPaymentRepository();
  }
  if (env.repositoryDriver === "json") {
    const repository = new JsonFilePaymentRepository(
      path.resolve(env.jsonStorePath),
      logger,
    );
    await repository.init();
    return repository;
  }
  const pool = new Pool({ connectionString: env.databaseUrl });
  if (env.autoMigrate) {
    await applyMigrations(pool);
  }
  const repository = new PostgresPaymentRepository(pool);
  await repository.ping();
  return repository;
}

export function buildLogger(level: string): AppLogger & Logger {
  return createLogger(level);
}
