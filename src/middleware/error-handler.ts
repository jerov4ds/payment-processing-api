import type { NextFunction, Request, Response } from "express";
import type { Env } from "../config/env";
import { toProblem } from "../http/problem";

export function errorHandler(env: Pick<Env, "nodeEnv" | "problemBaseUri">) {
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
      exposeStack: env.nodeEnv === "development",
    });
    res.status(problem.status).type("application/problem+json").json(problem);
  };
}
