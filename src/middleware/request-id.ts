import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function requestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header("x-request-id");
  const id =
    incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
