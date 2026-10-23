import request from "supertest";
import { MemoryPaymentRepository } from "../../src/adapters/persistence/memory-payment-repository";
import { createTestApp } from "../helpers/app";

describe("HTTP security edge", () => {
  const body = {
    amount: 100,
    currency: "NGN",
    paymentMethod: { type: "card", token: "tok_4242" },
  };

  it("requires a known API key and echoes a safe request id", async () => {
    const { app, apiKey } = await createTestApp();
    const missing = await request(app)
      .get("/api/v1/payments")
      .set("X-Request-Id", "trace-1");
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe("UNAUTHORIZED");
    expect(missing.headers["x-request-id"]).toBe("trace-1");
    const wrong = await request(app)
      .get("/api/v1/payments")
      .set("X-Api-Key", "not-the-key");
    expect(wrong.status).toBe(401);
    const replaced = await request(app)
      .get("/health/live")
      .set("X-Request-Id", "bad id");
    expect(replaced.headers["x-request-id"]).not.toBe("bad id");
    const ok = await request(app)
      .post("/api/v1/payments")
      .set("X-Api-Key", apiKey)
      .set("Idempotency-Key", "auth-ok-key")
      .send(body);
    expect(ok.status).toBe(202);
  });

  it("sets a helmet header and reflects only allow-listed origins", async () => {
    const { app, apiKey } = await createTestApp();
    const allowed = await request(app)
      .get("/health/live")
      .set("Origin", "https://merchant.example");
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://merchant.example",
    );
    const denied = await request(app)
      .get("/health/live")
      .set("Origin", "https://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    const secured = await request(app)
      .get("/api/v1/payments")
      .set("X-Api-Key", apiKey);
    expect(secured.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("returns 413 for an oversized body and 429 after the rate limit", async () => {
    const limited = await createTestApp({
      env: { BODY_LIMIT_BYTES: "128", RATE_LIMIT_MAX: "2" },
    });
    const oversized = await request(limited.app)
      .post("/api/v1/payments")
      .set("X-Api-Key", limited.apiKey)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", "too-big-key-1")
      .send({ ...body, description: "x".repeat(400) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.code).toBe("PAYLOAD_TOO_LARGE");

    const rated = await createTestApp({ env: { RATE_LIMIT_MAX: "2" } });
    const first = await request(rated.app)
      .get("/api/v1/payments")
      .set("X-Api-Key", rated.apiKey);
    const second = await request(rated.app)
      .get("/api/v1/payments")
      .set("X-Api-Key", rated.apiKey);
    const third = await request(rated.app)
      .get("/api/v1/payments")
      .set("X-Api-Key", rated.apiKey);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("RATE_LIMITED");
    const health = await request(rated.app).get("/health/live");
    expect(health.status).toBe(200);
  });

  it("hides another client's payments", async () => {
    const { app, apiKey } = await createTestApp();
    const created = await request(app)
      .post("/api/v1/payments")
      .set("X-Api-Key", apiKey)
      .set("Idempotency-Key", "owner-order-key")
      .send(body);
    expect(created.status).toBe(202);
    const id = created.body.id as string;
    const read = await request(app)
      .get(`/api/v1/payments/${id}`)
      .set("X-Api-Key", "merchant-key");
    expect(read.status).toBe(404);
    expect(read.body.code).toBe("PAYMENT_NOT_FOUND");
    const list = await request(app)
      .get("/api/v1/payments")
      .set("X-Api-Key", "merchant-key");
    expect(list.status).toBe(200);
    expect(list.body.page.total).toBe(0);
    const cancel = await request(app)
      .patch(`/api/v1/payments/${id}/status`)
      .set("X-Api-Key", "merchant-key")
      .send({ status: "CANCELLED" });
    expect(cancel.status).toBe(404);
    const owner = await request(app)
      .get(`/api/v1/payments/${id}`)
      .set("X-Api-Key", apiKey);
    expect(owner.status).toBe(200);
    expect(owner.body.clientId).toBe("demo");
  });

  it("hides internal error details outside development", async () => {
    class BoomRepository extends MemoryPaymentRepository {
      override async findById(): Promise<null> {
        throw new Error("disk sector 7 secret");
      }
    }
    const { app, apiKey } = await createTestApp({
      repository: new BoomRepository(),
    });
    const response = await request(app)
      .get("/api/v1/payments/3fa85f64-5717-4562-b3fc-2c963f66afa6")
      .set("X-Api-Key", apiKey);
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(response.body.stack).toBeUndefined();

    const development = await createTestApp({
      env: { NODE_ENV: "development" },
      repository: new BoomRepository(),
    });
    const exposed = await request(development.app)
      .get("/api/v1/payments/3fa85f64-5717-4562-b3fc-2c963f66afa6")
      .set("X-Api-Key", development.apiKey);
    expect(exposed.status).toBe(500);
    expect(JSON.stringify(exposed.body)).not.toContain("secret");
    expect(exposed.body.stack).toBeUndefined();
  });

  it("serves a 404 problem for an unknown route", async () => {
    const { app } = await createTestApp();
    const response = await request(app).get("/missing");
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ROUTE_NOT_FOUND");
  });
});
