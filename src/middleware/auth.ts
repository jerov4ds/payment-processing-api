import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { ApiClient } from "../config/env";
import { UnauthorizedError } from "../domain/errors";

export function apiKeyAuth(clients: ApiClient[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header("x-api-key");
    if (!header) {
      next(new UnauthorizedError());
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
    if (!clientId) {
      next(new UnauthorizedError());
      return;
    }
    req.clientId = clientId;
    next();
  };
}
