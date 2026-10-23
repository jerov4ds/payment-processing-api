import type { Request, Response } from "express";
import { NotReadyError } from "../domain/errors";
import type { PaymentRepository } from "../repositories/payment-repository";
import type { Readiness } from "../middleware/shutdown-gate";

export function createHealthController(
  repository: PaymentRepository,
  readiness: Readiness,
) {
  return {
    live(_req: Request, res: Response): void {
      res.status(200).json({ status: "ok" });
    },
    async ready(_req: Request, res: Response): Promise<void> {
      if (readiness.shuttingDown) {
        throw new NotReadyError("Service is shutting down");
      }
      try {
        await repository.ping();
      } catch {
        throw new NotReadyError("Storage is unavailable");
      }
      res.status(200).json({ status: "ok" });
    },
  };
}
