import dotenv from "dotenv";
import type { Server } from "node:http";
import type { Logger } from "pino";
import { createApp } from "./app";
import { buildLogger, createContainer } from "./composition/create-container";
import { loadEnv, type Env } from "./config/env";
import type { AppLogger } from "./ports/logger";
import { gracefulShutdown } from "./services/shutdown";

dotenv.config();

async function main(): Promise<void> {
  const env = loadConfig();
  const logger = buildLogger(env.logLevel);
  try {
    await start(env, logger);
  } catch (error) {
    logger.fatal({ err: error }, "startup failed");
    exitAfterFlush(logger, 1);
  }
}

function loadConfig(): Env {
  try {
    return loadEnv(process.env);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid configuration";
    console.error(message);
    process.exit(1);
  }
}

async function start(env: Env, logger: AppLogger & Logger): Promise<void> {
  const container = await createContainer(env, logger);
  const readiness = { shuttingDown: false };
  const recovered = await container.processor.recover();
  logger.info({ recovered }, "recovered payments");
  container.queue.start((paymentId) => container.processor.process(paymentId));
  const reconciler = setInterval(() => {
    void container.processor.recover().catch((error: unknown) => {
      logger.error({ err: error }, "reconcile failed");
    });
  }, env.reconcileIntervalMs);
  reconciler.unref();
  const app = createApp({
    env,
    logger,
    paymentService: container.paymentService,
    repository: container.repository,
    readiness,
  });
  const server = await listen(app, env.port, env.host);
  logger.info(
    { port: env.port, host: env.host, driver: env.repositoryDriver },
    "listening",
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    void gracefulShutdown({
      server,
      queue: container.queue,
      closeStorage: () => container.repository.close(),
      drainMs: env.shutdownDrainMs,
      logger,
      markNotReady: () => {
        readiness.shuttingDown = true;
      },
      stopReconciler: () => {
        clearInterval(reconciler);
      },
    })
      .then(() => {
        exitAfterFlush(logger, 0);
      })
      .catch((error: unknown) => {
        logger.fatal({ err: error }, "shutdown failed");
        exitAfterFlush(logger, 1);
      });
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
}

function listen(
  app: ReturnType<typeof createApp>,
  port: number,
  host: string,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

function exitAfterFlush(logger: Logger, code: number): void {
  const finish = (): void => {
    process.exit(code);
  };
  if (typeof logger.flush === "function") {
    logger.flush(finish);
    return;
  }
  finish();
}

if (require.main === module) {
  void main();
}
