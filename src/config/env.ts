import { createHash } from "node:crypto";
import { z } from "zod";
import { ConfigError } from "../domain/errors";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(0).max(65535).default(4317),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    API_KEYS: z.string().min(1),
    REPOSITORY_DRIVER: z.enum(["json", "postgres", "memory"]).default("json"),
    JSON_STORE_PATH: z.string().min(1).default("./data/payments.json"),
    DATABASE_URL: z.string().min(1).optional(),
    AUTO_MIGRATE: z.enum(["true", "false"]).default("true"),
    CORS_ORIGINS: z.string().default(""),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(16_384),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    GATEWAY_MIN_LATENCY_MS: z.coerce.number().int().nonnegative().default(20),
    GATEWAY_MAX_LATENCY_MS: z.coerce.number().int().nonnegative().default(50),
    GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
    GATEWAY_TRANSIENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
    GATEWAY_PERMANENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
    GATEWAY_SEED: z.coerce.number().int().default(1),
    PAYMENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
    RETRY_BASE_DELAY_MS: z.coerce.number().int().nonnegative().default(50),
    RETRY_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(2_000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().nonnegative().default(10_000),
    PROCESSING_LEASE_MS: z.coerce.number().int().positive().default(5_000),
    RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
    PROBLEM_BASE_URI: z
      .string()
      .url()
      .default("https://payment-service.local/problems"),
  })
  .superRefine((value, ctx) => {
    if (value.GATEWAY_MIN_LATENCY_MS > value.GATEWAY_MAX_LATENCY_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["GATEWAY_MIN_LATENCY_MS"],
        message: "must be less than or equal to GATEWAY_MAX_LATENCY_MS",
      });
    }
    if (
      value.GATEWAY_TRANSIENT_FAILURE_RATE +
        value.GATEWAY_PERMANENT_FAILURE_RATE >
      1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["GATEWAY_TRANSIENT_FAILURE_RATE"],
        message: "transient and permanent failure rates must sum to at most 1",
      });
    }
    if (value.RETRY_BASE_DELAY_MS > value.RETRY_MAX_DELAY_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["RETRY_BASE_DELAY_MS"],
        message: "must be less than or equal to RETRY_MAX_DELAY_MS",
      });
    }
    if (value.REPOSITORY_DRIVER === "postgres" && !value.DATABASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "is required when REPOSITORY_DRIVER=postgres",
      });
    }
  });

export interface ApiClient {
  clientId: string;
  secretHash: Buffer;
}

export interface Env {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  apiClients: ApiClient[];
  repositoryDriver: "json" | "postgres" | "memory";
  jsonStorePath: string;
  databaseUrl?: string;
  autoMigrate: boolean;
  corsOrigins: string[];
  bodyLimitBytes: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  gatewayMinLatencyMs: number;
  gatewayMaxLatencyMs: number;
  gatewayTimeoutMs: number;
  gatewayTransientFailureRate: number;
  gatewayPermanentFailureRate: number;
  gatewaySeed: number;
  paymentMaxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  workerConcurrency: number;
  shutdownDrainMs: number;
  processingLeaseMs: number;
  reconcileIntervalMs: number;
  problemBaseUri: string;
}

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value !== "") {
      cleaned[key] = value;
    }
  }
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(message);
  }
  const data = parsed.data;
  return {
    nodeEnv: data.NODE_ENV,
    host: data.HOST,
    port: data.PORT,
    logLevel: data.LOG_LEVEL,
    apiClients: parseApiKeys(data.API_KEYS),
    repositoryDriver: data.REPOSITORY_DRIVER,
    jsonStorePath: data.JSON_STORE_PATH,
    databaseUrl: data.DATABASE_URL,
    autoMigrate: data.AUTO_MIGRATE === "true",
    corsOrigins: data.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    bodyLimitBytes: data.BODY_LIMIT_BYTES,
    rateLimitWindowMs: data.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: data.RATE_LIMIT_MAX,
    gatewayMinLatencyMs: data.GATEWAY_MIN_LATENCY_MS,
    gatewayMaxLatencyMs: data.GATEWAY_MAX_LATENCY_MS,
    gatewayTimeoutMs: data.GATEWAY_TIMEOUT_MS,
    gatewayTransientFailureRate: data.GATEWAY_TRANSIENT_FAILURE_RATE,
    gatewayPermanentFailureRate: data.GATEWAY_PERMANENT_FAILURE_RATE,
    gatewaySeed: data.GATEWAY_SEED,
    paymentMaxAttempts: data.PAYMENT_MAX_ATTEMPTS,
    retryBaseDelayMs: data.RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: data.RETRY_MAX_DELAY_MS,
    workerConcurrency: data.WORKER_CONCURRENCY,
    shutdownDrainMs: data.SHUTDOWN_DRAIN_MS,
    processingLeaseMs: data.PROCESSING_LEASE_MS,
    reconcileIntervalMs: data.RECONCILE_INTERVAL_MS,
    problemBaseUri: data.PROBLEM_BASE_URI,
  };
}

export function parseApiKeys(raw: string): ApiClient[] {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new ConfigError(
      "API_KEYS must contain at least one clientId:secret pair",
    );
  }
  const seen = new Set<string>();
  return entries.map((entry) => {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new ConfigError("API_KEYS entries must be clientId:secret");
    }
    const clientId = entry.slice(0, separator);
    const secret = entry.slice(separator + 1);
    if (!CLIENT_ID_PATTERN.test(clientId)) {
      throw new ConfigError(`Invalid API client id: ${clientId}`);
    }
    if (secret.length < 8) {
      throw new ConfigError(
        `API key secret for ${clientId} must be at least 8 characters`,
      );
    }
    if (seen.has(clientId)) {
      throw new ConfigError(`Duplicate API client id: ${clientId}`);
    }
    seen.add(clientId);
    return {
      clientId,
      secretHash: createHash("sha256").update(secret).digest(),
    };
  });
}
