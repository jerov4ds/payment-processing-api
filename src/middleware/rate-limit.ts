import type { RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { Env } from "../config/env";
import { RateLimitedError } from "../domain/errors";

const VALIDATE = {
  trustProxy: false,
  xForwardedForHeader: false,
  forwardedHeader: false,
} as const;

/**
 * Runs before authentication. Only 401 responses count, so a working client is
 * not slowed down, but rotating made-up keys from one address is.
 */
export function createAuthFailureLimiter(env: Env): RequestHandler {
  return rateLimit({
    windowMs: env.rateLimitWindowMs,
    limit: env.authFailureRateLimitMax,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? "127.0.0.1"),
    handler: (_req, _res, next) => {
      next(new RateLimitedError());
    },
    validate: VALIDATE,
  });
}

/** Runs after authentication, so the bucket is the verified client, not a header value. */
export function createClientRateLimiter(env: Env): RequestHandler {
  return rateLimit({
    windowMs: env.rateLimitWindowMs,
    limit: env.rateLimitMax,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) =>
      req.clientId
        ? `client:${req.clientId}`
        : ipKeyGenerator(req.ip ?? "127.0.0.1"),
    handler: (_req, _res, next) => {
      next(new RateLimitedError());
    },
    validate: VALIDATE,
  });
}
