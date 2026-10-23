import { Router } from "express";
import { createPaymentController } from "../controllers/payment-controller";
import { asyncHandler } from "../middleware/async-handler";
import type { PaymentService } from "../services/payment-service";

export function paymentRouter(service: PaymentService): Router {
  const controller = createPaymentController(service);
  const router = Router();
  router.post(
    "/payments",
    asyncHandler((req, res) => controller.create(req, res)),
  );
  router.get(
    "/payments",
    asyncHandler((req, res) => controller.list(req, res)),
  );
  router.get(
    "/payments/:id",
    asyncHandler((req, res) => controller.get(req, res)),
  );
  router.patch(
    "/payments/:id/status",
    asyncHandler((req, res) => controller.updateStatus(req, res)),
  );
  return router;
}
