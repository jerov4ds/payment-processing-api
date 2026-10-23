import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { Env } from "../config/env";
import { RateLimitedError } from "../domain/errors";

export function createRateLimiter(env: Env): RequestHandler {
  return rateLimit({
    windowMs: env.rateLimitWindowMs,
    limit: env.rateLimitMax,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => req.path.startsWith("/health"),
    keyGenerator: (req) => {
      const apiKey = req.header("x-api-key");
      if (apiKey) {
        return createHash("sha256").update(apiKey).digest("hex");
      }
      return ipKeyGenerator(req.ip ?? "127.0.0.1");
    },
    handler: (_req, _res, next) => {
      next(new RateLimitedError());
    },
    validate: {
      trustProxy: false,
      xForwardedForHeader: false,
      forwardedHeader: false,
    },
  });
}
