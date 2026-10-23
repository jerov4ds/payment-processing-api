import request from "supertest";
import { buildOpenApiSpec } from "../../src/openapi/spec";
import { createTestApp } from "../helpers/app";

describe("OpenAPI", () => {
  it("describes the payment and health routes", () => {
    const spec = buildOpenApiSpec() as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
      components?: { securitySchemes?: Record<string, { name?: string }> };
    };
    expect(spec.paths["/api/v1/payments"]?.post).toBeDefined();
    expect(spec.paths["/api/v1/payments/{id}"]?.get).toBeDefined();
    expect(spec.paths["/api/v1/payments/{id}/status"]?.patch).toBeDefined();
    expect(spec.paths["/health/live"]?.get).toBeDefined();
    expect(spec.paths["/health/ready"]?.get).toBeDefined();
    expect(spec.components?.securitySchemes?.ApiKeyAuth?.name).toBe(
      "X-Api-Key",
    );
    expect(spec.paths["/api/v1/payments"]?.post?.security).toEqual([
      { ApiKeyAuth: [] },
    ]);
  });

  it("serves the document and Swagger UI without an API key", async () => {
    const { app } = await createTestApp();
    const spec = await request(app).get("/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.paths["/api/v1/payments"]).toBeDefined();
    const docs = await request(app).get("/docs/");
    expect(docs.status).toBe(200);
    expect(docs.text).toContain("swagger");
  });
});
