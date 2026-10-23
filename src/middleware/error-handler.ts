import type { NextFunction, Request, Response } from "express";
import type { Env } from "../config/env";
import { toProblem } from "../http/problem";
import type { AppLogger } from "../ports/logger";

export function errorHandler(
  env: Pick<Env, "problemBaseUri">,
  logger: AppLogger,
) {
  return (
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    const problem = toProblem(err, {
      requestId: req.requestId ?? "unknown",
      instance: req.originalUrl,
      problemBaseUri: env.problemBaseUri,
    });
    if (problem.status >= 500) {
      logger.error(
        { err, requestId: problem.requestId, code: problem.code },
        "request failed",
      );
    }
    res.status(problem.status).type("application/problem+json").json(problem);
  };
}
