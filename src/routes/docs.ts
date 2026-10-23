import { Router } from "express";
import swaggerUi from "swagger-ui-express";

export function docsRouter(spec: object): Router {
  const router = Router();
  router.get("/openapi.json", (_req, res) => {
    res.json(spec);
  });
  router.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(spec, { swaggerOptions: { persistAuthorization: true } }),
  );
  return router;
}
