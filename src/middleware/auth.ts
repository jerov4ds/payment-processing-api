import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { ApiClient } from "../config/env";
import { UnauthorizedError } from "../domain/errors";

/** Sets `req.clientId` when the API key verifies. Never rejects, so a limiter can sit between this and `requireClient`. */
export function identifyClient(clients: ApiClient[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header("x-api-key");
    if (!header) {
      next();
      return;
    }
    const incoming = createHash("sha256").update(header).digest();
    let clientId: string | undefined;
    for (const client of clients) {
      if (
        incoming.length === client.secretHash.length &&
        timingSafeEqual(incoming, client.secretHash)
      ) {
        clientId = client.clientId;
      }
    }
    if (clientId) {
      req.clientId = clientId;
    }
    next();
  };
}

export function requireClient() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    next(req.clientId ? undefined : new UnauthorizedError());
  };
}
