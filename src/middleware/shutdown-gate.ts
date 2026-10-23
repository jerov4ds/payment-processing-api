import type { NextFunction, Request, Response } from "express";
import { NotReadyError } from "../domain/errors";

export interface Readiness {
  shuttingDown: boolean;
}

export function rejectWhenShuttingDown(readiness: Readiness) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (readiness.shuttingDown && !req.path.startsWith("/health")) {
      next(new NotReadyError("Service is shutting down"));
      return;
    }
    next();
  };
}
