import type { NextFunction, Request, Response } from "express";
import { UnsupportedMediaTypeError } from "../domain/errors";

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export function requireJson(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (req.method !== "POST" && req.method !== "PATCH" && req.method !== "PUT") {
    next();
    return;
  }
  const header = req.header("content-type");
  if (!header || !JSON_TYPE.test(header.split(",")[0]?.trim() ?? "")) {
    next(new UnsupportedMediaTypeError());
    return;
  }
  next();
}
