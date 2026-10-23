import type { Server } from "node:http";
import type { JobQueue } from "../ports/job-queue";
import type { AppLogger } from "../ports/logger";

export interface ShutdownDeps {
  server: Server;
  queue: JobQueue;
  closeStorage: () => Promise<void>;
  drainMs: number;
  logger: AppLogger;
  markNotReady: () => void;
  stopReconciler: () => void;
}

export async function gracefulShutdown(
  deps: ShutdownDeps,
): Promise<{ drained: boolean; inflight: number }> {
  deps.markNotReady();
  deps.stopReconciler();
  await closeServer(deps.server);
  const result = await deps.queue.drain(deps.drainMs);
  await deps.closeStorage();
  if (result.drained) {
    deps.logger.info(
      { inflight: result.inflight },
      "shutdown drained in-flight jobs",
    );
  } else {
    deps.logger.warn(
      { inflight: result.inflight },
      "shutdown drain timed out; in-flight payments remain PROCESSING",
    );
  }
  return result;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
