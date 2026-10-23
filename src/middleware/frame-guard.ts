import type { NextFunction, Request, Response } from "express";

export function denyFraming(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Frame-Options", "DENY");
  if (!req.path.startsWith("/api") && !req.path.startsWith("/health")) {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  }
  next();
}
