import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { Env } from "../config/env";
import { RateLimitedError } from "../domain/errors";

function limiter(
  env: Env,
  options: {
    limit: number;
    keyGenerator: (req: Request) => string;
    skip?: (req: Request) => boolean;
    skipSuccessfulRequests?: boolean;
    requestWasSuccessful?: (req: Request) => boolean;
  },
): RequestHandler {
  return rateLimit({
    windowMs: env.rateLimitWindowMs,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new RateLimitedError());
    },
    validate: {
      trustProxy: false,
      xForwardedForHeader: false,
      forwardedHeader: false,
    },
    ...options,
  });
}

function address(req: Request): string {
  return ipKeyGenerator(req.ip ?? "127.0.0.1");
}

/** Pages outside the API, per address. Health probes and `/api` are exempt. */
export function createAddressRateLimiter(env: Env): RequestHandler {
  return limiter(env, {
    limit: env.rateLimitMax,
    keyGenerator: address,
    skip: (req) =>
      req.path.startsWith("/health") || req.path.startsWith("/api"),
  });
}

/**
 * Sits between `identifyClient` and `requireClient`. Only requests whose key
 * did not verify count toward the limit, so a working client never trips it.
 * Once an address is over, every request from it is refused until the window
 * resets, including one with a valid key, so a correct guess looks the same
 * as a wrong one.
 */
export function createAuthFailureLimiter(env: Env): RequestHandler {
  return limiter(env, {
    limit: env.authFailureRateLimitMax,
    keyGenerator: address,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req) => Boolean(req.clientId),
  });
}

/** Runs after authentication, so the bucket is the verified client, not a header value. */
export function createClientRateLimiter(env: Env): RequestHandler {
  return limiter(env, {
    limit: env.rateLimitMax,
    keyGenerator: (req) => `client:${req.clientId ?? address(req)}`,
  });
}
