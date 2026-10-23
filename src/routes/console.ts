import { Router } from "express";
import { consolePage } from "../http/console-page";

export function consoleRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res
      .status(200)
      .set("Cache-Control", "no-store")
      .type("html")
      .send(consolePage());
  });
  return router;
}
