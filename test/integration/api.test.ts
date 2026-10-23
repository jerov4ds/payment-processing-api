import request from "supertest";
import { MemoryPaymentRepository } from "../../src/adapters/persistence/memory-payment-repository";
import { ScriptedGateway, waitFor } from "../helpers/fixtures";
import { createTestApp } from "../helpers/app";

const body = {
  amount: 150000,
  currency: "NGN",
  description: "Order 1042",
  paymentMethod: { type: "card", token: "tok_visa_4242" },
  metadata: { orderId: "1042" },
};

describe("payment HTTP API", () => {
  async function postPayment(
    app: Awaited<ReturnType<typeof createTestApp>>["app"],
    apiKey: string,
    idempotencyKey = "order-1042-key",
    payload: object = body,
  ) {
    return request(app)
      .post("/api/v1/payments")
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", idempotencyKey)
      .send(payload);
  }

  it("accepts a payment and reaches a terminal state in the background", async () => {
    const gateway = new ScriptedGateway(["ok"]);
    const { app, apiKey, container } = await createTestApp({
      gateway,
      startQueue: true,
    });
    const created = await postPayment(app, apiKey);
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({
      status: "PENDING",
      amount: 150000,
      currency: "NGN",
      paymentMethod: { type: "card", last4: "4242" },
      attempts: 0,
      version: 1,
    });
    expect(created.headers.location).toBe(
      `/api/v1/payments/${created.body.id}`,
    );
    expect(JSON.stringify(created.body)).not.toContain("tok_visa");

    let current = created.body as { id: string; status: string };
    await waitFor(async () => {
      const response = await request(app)
        .get(`/api/v1/payments/${current.id}`)
        .set("X-Api-Key", apiKey);
      current = response.body as { id: string; status: string };
      return current.status === "SUCCEEDED";
    });
    expect(current.status).toBe("SUCCEEDED");
    expect(gateway.calls).toHaveLength(1);
    container.queue.pause();
  });

  it("retries a transient gateway failure and then succeeds", async () => {
    const gateway = new ScriptedGateway(["transient", "ok"]);
    const { app, apiKey, container } = await createTestApp({
      gateway,
      startQueue: true,
    });
    const created = await postPayment(app, apiKey);
    await waitFor(async () => {
      const response = await request(app)
        .get(`/api/v1/payments/${created.body.id}`)
        .set("X-Api-Key", apiKey);
      return (
        response.body.status === "SUCCEEDED" && response.body.attempts === 2
      );
    });
    container.queue.pause();
  });

  it("records a permanent decline without retrying", async () => {
    const gateway = new ScriptedGateway(["declined"]);
    const { app, apiKey, container } = await createTestApp({
      gateway,
      startQueue: true,
    });
    const created = await postPayment(app, apiKey);
    await waitFor(async () => {
      const response = await request(app)
        .get(`/api/v1/payments/${created.body.id}`)
        .set("X-Api-Key", apiKey);
      return response.body.status === "FAILED";
    });
    const stored = await request(app)
      .get(`/api/v1/payments/${created.body.id}`)
      .set("X-Api-Key", apiKey);
    expect(stored.body).toMatchObject({
      status: "FAILED",
      failureReason: "PAYMENT_DECLINED",
      attempts: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const again = await request(app)
      .get(`/api/v1/payments/${created.body.id}`)
      .set("X-Api-Key", apiKey);
    expect(again.body.attempts).toBe(1);
    container.queue.pause();
  });

  it("creates one payment when the same idempotent POST is repeated, including in parallel", async () => {
    const { app, apiKey } = await createTestApp();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        postPayment(app, apiKey, "parallel-order-key"),
      ),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const ids = new Set(responses.map((response) => response.body.id));
    expect(ids.size).toBe(1);
    const replay = await postPayment(app, apiKey, "parallel-order-key");
    expect(replay.body).toEqual(responses[0]?.body);

    const conflict = await postPayment(app, apiKey, "parallel-order-key", {
      ...body,
      amount: 50,
    });
    expect(conflict.status).toBe(422);
    expect(conflict.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(conflict.headers["content-type"]).toContain(
      "application/problem+json",
    );
  });

  it("returns the original pending snapshot after the worker finishes", async () => {
    const { app, apiKey, container } = await createTestApp({
      gateway: new ScriptedGateway(["ok"]),
      startQueue: true,
    });
    const created = await postPayment(app, apiKey, "snapshot-key");
    await waitFor(async () => {
      const response = await request(app)
        .get(`/api/v1/payments/${created.body.id}`)
        .set("X-Api-Key", apiKey);
      return response.body.status === "SUCCEEDED";
    });
    const replay = await postPayment(app, apiKey, "snapshot-key");
    expect(replay.status).toBe(202);
    expect(replay.body.status).toBe("PENDING");
    container.queue.pause();
  });

  it("cancels once under parallel patches and refunds only after success", async () => {
    const { app, apiKey } = await createTestApp();
    const created = await postPayment(app, apiKey, "cancel-key");
    const patches = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .patch(`/api/v1/payments/${created.body.id}/status`)
          .set("X-Api-Key", apiKey)
          .set("Content-Type", "application/json")
          .send({ status: "CANCELLED", reason: "customer" }),
      ),
    );
    const winners = patches.filter((response) => response.status === 200);
    const losers = patches.filter((response) => response.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    expect(winners[0]?.body).toMatchObject({
      status: "CANCELLED",
      statusReason: "customer",
    });

    const refund = await request(app)
      .patch(`/api/v1/payments/${created.body.id}/status`)
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .send({ status: "REFUNDED" });
    expect(refund.status).toBe(409);
    expect(refund.body.code).toBe("INVALID_TRANSITION");
  });

  it("refunds a succeeded payment and honors If-Match", async () => {
    const { app, apiKey, container } = await createTestApp({
      gateway: new ScriptedGateway(["ok"]),
      startQueue: true,
    });
    const created = await postPayment(app, apiKey, "refund-key");
    await waitFor(async () => {
      const response = await request(app)
        .get(`/api/v1/payments/${created.body.id}`)
        .set("X-Api-Key", apiKey);
      return response.body.status === "SUCCEEDED";
    });
    const stale = await request(app)
      .patch(`/api/v1/payments/${created.body.id}/status`)
      .set("X-Api-Key", apiKey)
      .set("If-Match", "1")
      .set("Content-Type", "application/json")
      .send({ status: "REFUNDED" });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const current = await request(app)
      .get(`/api/v1/payments/${created.body.id}`)
      .set("X-Api-Key", apiKey);
    const refunded = await request(app)
      .patch(`/api/v1/payments/${created.body.id}/status`)
      .set("X-Api-Key", apiKey)
      .set("If-Match", String(current.body.version))
      .set("Content-Type", "application/json")
      .send({ status: "REFUNDED", reason: "duplicate" });
    expect(refunded.status).toBe(200);
    expect(refunded.body).toMatchObject({
      status: "REFUNDED",
      statusReason: "duplicate",
    });
    container.queue.pause();
  });

  it("validates ids, filters a page, and strips unknown fields", async () => {
    const { app, apiKey } = await createTestApp();
    const created = await postPayment(app, apiKey, "list-key", {
      ...body,
      unexpected: true,
    });
    expect(created.status).toBe(202);
    expect(created.body.unexpected).toBeUndefined();
    const missing = await request(app)
      .get("/api/v1/payments/3fa85f64-5717-4562-b3fc-2c963f66af10")
      .set("X-Api-Key", apiKey);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("PAYMENT_NOT_FOUND");
    const invalid = await request(app)
      .get("/api/v1/payments/not-a-uuid")
      .set("X-Api-Key", apiKey);
    expect(invalid.status).toBe(400);
    const page = await request(app)
      .get("/api/v1/payments")
      .query({ status: "PENDING", limit: 10, offset: 0 })
      .set("X-Api-Key", apiKey);
    expect(page.status).toBe(200);
    expect(page.body.page.total).toBe(1);
    expect(page.body.data[0].id).toBe(created.body.id);
    const badFilter = await request(app)
      .get("/api/v1/payments")
      .query({ status: "HOLD" })
      .set("X-Api-Key", apiKey);
    expect(badFilter.status).toBe(400);
  });

  it("rejects client attempts to set a processor-owned status", async () => {
    const { app, apiKey } = await createTestApp();
    const created = await postPayment(app, apiKey, "status-key");
    const response = await request(app)
      .patch(`/api/v1/payments/${created.body.id}/status`)
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .send({ status: "SUCCEEDED" });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("requires an idempotency key and a JSON content type", async () => {
    const { app, apiKey } = await createTestApp();
    const missing = await request(app)
      .post("/api/v1/payments")
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .send(body);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("MISSING_IDEMPOTENCY_KEY");
    const text = await request(app)
      .post("/api/v1/payments")
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "text/plain")
      .set("Idempotency-Key", "plain-text-key")
      .send("hello");
    expect(text.status).toBe(415);
    const broken = await request(app)
      .post("/api/v1/payments")
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", "broken-json-key")
      .send("{");
    expect(broken.status).toBe(400);
    expect(broken.body.detail).toMatch(/JSON/);
  });

  it("does not let a prototype payload pollute Object", async () => {
    const { app, apiKey } = await createTestApp();
    const response = await request(app)
      .post("/api/v1/payments")
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", "proto-test-key")
      .send(
        '{"amount":100,"currency":"NGN","paymentMethod":{"type":"card","token":"tok_4242"},"__proto__":{"polluted":"yes"}}',
      );
    expect(response.status).toBe(202);
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });

  it("returns 503 for API traffic while shutting down and keeps liveness up", async () => {
    const { app, apiKey, readiness } = await createTestApp();
    readiness.shuttingDown = true;
    const live = await request(app).get("/health/live");
    expect(live.status).toBe(200);
    const ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body.code).toBe("NOT_READY");
    const blocked = await postPayment(app, apiKey, "during-shutdown");
    expect(blocked.status).toBe(503);
  });

  it("reports storage as not ready when ping fails", async () => {
    class BrokenRepository extends MemoryPaymentRepository {
      override async ping(): Promise<void> {
        throw new Error("disk unavailable");
      }
    }
    const { app } = await createTestApp({ repository: new BrokenRepository() });
    const ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(503);
    const live = await request(app).get("/health/live");
    expect(live.status).toBe(200);
  });
});
