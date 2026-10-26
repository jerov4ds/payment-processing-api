import type { AppLogger } from "../ports/logger";

export interface CrashSource {
  on(
    event: "uncaughtException" | "unhandledRejection",
    listener: (error: unknown) => void,
  ): unknown;
}

/**
 * After an uncaught error the process state is unknown, so it logs and exits
 * instead of carrying on. A payment left PROCESSING is reclaimed by the next
 * process once its lease expires.
 */
export function installCrashHandlers(
  source: CrashSource,
  logger: AppLogger,
  exit: (code: number) => void,
): void {
  let exiting = false;
  const crash = (message: string) => (error: unknown) => {
    logger.fatal({ err: error }, message);
    if (exiting) {
      return;
    }
    exiting = true;
    exit(1);
  };
  source.on("uncaughtException", crash("uncaught exception"));
  source.on("unhandledRejection", crash("unhandled promise rejection"));
}
