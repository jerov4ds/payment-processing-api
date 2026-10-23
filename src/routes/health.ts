import { Router } from "express";
import { createHealthController } from "../controllers/health-controller";
import { asyncHandler } from "../middleware/async-handler";
import type { Readiness } from "../middleware/shutdown-gate";
import type { PaymentRepository } from "../repositories/payment-repository";

export function healthRouter(
  repository: PaymentRepository,
  readiness: Readiness,
): Router {
  const controller = createHealthController(repository, readiness);
  const router = Router();
  router.get("/live", (req, res) => {
    controller.live(req, res);
  });
  router.get(
    "/ready",
    asyncHandler((req, res) => controller.ready(req, res)),
  );
  return router;
}
