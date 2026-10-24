import request from "supertest";
import type { Express } from "express";
import type { FailureReason, Payment } from "../../src/domain/payment";
import type { PaymentStatus } from "../../src/domain/payment-state-machine";
import type { PaymentRepository } from "../../src/repositories/payment-repository";
import { MAX_AMOUNT } from "../../src/domain/money";
import { ScriptedGateway, waitFor } from "../helpers/fixtures";
import { createTestApp } from "../helpers/app";

const body = {
  amount: 150000,
  currency: "NGN",
  description: "Order 1042",
  paymentMethod: { type: "card", token: "tok_visa_4242" },
  metadata: { orderId: "1042" },
};

describe("payment edge cases", () => {
  async function postPayment(
    app: Express,
    apiKey: string,
    idempotencyKey: string,
    payload: object | string = body,
    contentType = "application/json",
  ) {
    const call = request(app)
      .post("/api/v1/payments")
      .set("X-Api-Key", apiKey)
      .set("Idempotency-Key", idempotencyKey);
    if (contentType) {
      call.set("Content-Type", contentType);
    }
    return typeof payload === "string"
      ? call.send(payload)
      : call.send(payload);
  }

  it("accepts the inclusive bounds and rejects the values just outside them", async () => {
    const { app, apiKey } = await createTestApp();
    const accepted = [
      { amount: 1, currency: "NGN", token: "123456789012", type: "card" },
      {
        amount: MAX_AMOUNT,
        currency: "USD",
        token: "1".repeat(20),
        type: "card",
      },
      {
        amount: 2500,
        currency: "EUR",
        token: "a".repeat(64),
        type: "bank_transfer",
      },
      { amount: 99, currency: "GBP", token: "tok1", type: "wallet" },
    ] as const;
    for (const [index, row] of accepted.entries()) {
      const created = await postPayment(app, apiKey, `bound-ok-${index}`, {
        amount: row.amount,
        currency: row.currency,
        description: index === 3 ? " " : "d".repeat(255),
        paymentMethod: { type: row.type, token: row.token },
      });
      expect(created.status).toBe(202);
      expect(created.body).toMatchObject({
        amount: row.amount,
        currency: row.currency,
        paymentMethod: { type: row.type, last4: row.token.slice(-4) },
      });
      const hidden = row.token.slice(0, -4);
      if (hidden.length > 0) {
        expect(JSON.stringify(created.body)).not.toContain(hidden);
      }
    }
    const spaced = await postPayment(app, apiKey, "bound-space-desc", {
      ...body,
      description: " ",
    });
    expect(spaced.body.description).toBe(" ");

    const rejected: Array<{ key: string; payload: object; path: string }> = [
      {
        key: "reject-amount-zero",
        payload: { ...body, amount: 0 },
        path: "amount",
      },
      {
        key: "reject-amount-negative",
        payload: { ...body, amount: -1 },
        path: "amount",
      },
      {
        key: "reject-amount-float",
        payload: { ...body, amount: 10.5 },
        path: "amount",
      },
      {
        key: "reject-amount-max",
        payload: { ...body, amount: MAX_AMOUNT + 1 },
        path: "amount",
      },
      {
        key: "reject-amount-string",
        payload: { ...body, amount: "150000" },
        path: "amount",
      },
      {
        key: "reject-currency-lower",
        payload: { ...body, currency: "ngn" },
        path: "currency",
      },
      {
        key: "reject-currency-jpy",
        payload: { ...body, currency: "JPY" },
        path: "currency",
      },
      {
        key: "reject-description-empty",
        payload: { ...body, description: "" },
        path: "description",
      },
      {
        key: "reject-description-long",
        payload: { ...body, description: "d".repeat(256) },
        path: "description",
      },
      {
        key: "reject-type-cash",
        payload: {
          ...body,
          paymentMethod: { type: "cash", token: "tok_4242" },
        },
        path: "paymentMethod.type",
      },
      {
        key: "reject-type-case",
        payload: {
          ...body,
          paymentMethod: { type: "CARD", token: "tok_4242" },
        },
        path: "paymentMethod.type",
      },
      {
        key: "reject-token-short",
        payload: {
          ...body,
          paymentMethod: { type: "card", token: "abc" },
        },
        path: "paymentMethod.token",
      },
      {
        key: "reject-token-long",
        payload: {
          ...body,
          paymentMethod: { type: "card", token: "a".repeat(65) },
        },
        path: "paymentMethod.token",
      },
    ];
    for (const row of rejected) {
      const response = await postPayment(app, apiKey, row.key, row.payload);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(
        response.body.errors.map((error: { path: string }) => error.path),
      ).toContain(row.path);
    }

    for (const token of ["1".repeat(13), "4242424242424242", "1".repeat(19)]) {
      const response = await postPayment(
        app,
        apiKey,
        `raw-pan-${token.length}-key`,
        {
          ...body,
          paymentMethod: { type: "card", token },
        },
      );
      expect(response.status).toBe(400);
      expect(response.body.detail).toMatch(/card number/);
      expect(JSON.stringify(response.body)).not.toContain(token);
    }
  });

  it("rejects metadata past the documented limits and forbidden keys", async () => {
    const { app, apiKey } = await createTestApp();
    const twenty: Record<string, number | boolean | string> = {};
    for (let index = 0; index < 20; index += 1) {
      twenty[`k${index}`] = index;
    }
    twenty.k0 = true;
    twenty.k1 = "x".repeat(256);
    const ok = await postPayment(app, apiKey, "meta-20-keys", {
      ...body,
      metadata: twenty,
    });
    expect(ok.status).toBe(202);
    expect(ok.body.metadata.k0).toBe(true);
    expect(ok.body.metadata.k1).toHaveLength(256);
    expect(ok.body.metadata.k19).toBe(19);

    const tooMany = { ...twenty, extra: 1 };
    const overflow = await postPayment(app, apiKey, "meta-21-keys", {
      ...body,
      metadata: tooMany,
    });
    expect(overflow.status).toBe(400);
    expect(JSON.stringify(overflow.body)).toContain("at most 20");

    const cases: Array<{ key: string; metadata: object }> = [
      { key: "meta-long-str", metadata: { note: "n".repeat(257) } },
      { key: "meta-float", metadata: { note: 1.5 } },
      { key: "meta-null", metadata: { note: null } },
      { key: "meta-object", metadata: { note: { nested: true } } },
      { key: "meta-array", metadata: { note: ["a"] } },
      { key: "meta-space", metadata: { "has space": 1 } },
      { key: "meta-key-65", metadata: { ["k".repeat(65)]: 1 } },
      { key: "meta-ctor", metadata: { constructor: "x" } },
      { key: "meta-proto", metadata: { prototype: true } },
    ];
    for (const row of cases) {
      const response = await postPayment(app, apiKey, row.key, {
        ...body,
        metadata: row.metadata,
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    }
    const key64 = "k".repeat(64);
    const longKey = await postPayment(app, apiKey, "meta-key-64", {
      ...body,
      metadata: { [key64]: -3 },
    });
    expect(longKey.status).toBe(202);
    expect(longKey.body.metadata[key64]).toBe(-3);
  });

  it("scopes idempotency per client and hashes the canonical body", async () => {
    const { app, apiKey } = await createTestApp();
    const first = await postPayment(
      app,
      apiKey,
      "k".repeat(8),
      '{"metadata":{"b":1,"a":true},"paymentMethod":{"token":"wal_4242","type":"wallet"},"currency":"USD","amount":100}',
    );
    const replay = await postPayment(
      app,
      apiKey,
      "k".repeat(8),
      '{"amount":100,"currency":"USD","paymentMethod":{"type":"wallet","token":"wal_4242"},"metadata":{"a":true,"b":1}}',
    );
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body.id).toBe(first.body.id);

    const longestKey = "k".repeat(255);
    const longKey = await postPayment(app, apiKey, longestKey, {
      amount: 100,
      currency: "EUR",
      paymentMethod: { type: "card", token: "tok_4242" },
    });
    expect(longKey.status).toBe(202);
    const colonKey = await postPayment(app, apiKey, "order:1042.a_b-c", {
      amount: 100,
      currency: "GBP",
      paymentMethod: { type: "bank_transfer", token: "bank_4242" },
    });
    expect(colonKey.status).toBe(202);

    for (const key of ["1234567", "k".repeat(256), "bad key", "slash/key"]) {
      const response = await postPayment(app, apiKey, key);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    }
    const trimmed = await postPayment(app, apiKey, "  order-key  ");
    const trimmedReplay = await postPayment(app, apiKey, "order-key");
    expect(trimmed.status).toBe(202);
    expect(trimmedReplay.status).toBe(202);
    expect(trimmedReplay.body.id).toBe(trimmed.body.id);

    const merchant = await postPayment(
      app,
      "merchant-key",
      "k".repeat(8),
      '{"amount":100,"currency":"USD","paymentMethod":{"type":"wallet","token":"wal_4242"},"metadata":{"a":true,"b":1}}',
    );
    expect(merchant.status).toBe(202);
    expect(merchant.body.id).not.toBe(first.body.id);
    expect(merchant.body.clientId).toBe("merchant");

    const omitted = await postPayment(app, apiKey, "meta-omitted-key", {
      amount: 100,
      currency: "NGN",
      paymentMethod: { type: "card", token: "tok_4242" },
    });
    const emptyMeta = await postPayment(app, apiKey, "meta-omitted-key", {
      amount: 100,
      currency: "NGN",
      paymentMethod: { type: "card", token: "tok_4242" },
      metadata: {},
    });
    expect(omitted.status).toBe(202);
    expect(emptyMeta.status).toBe(422);
    expect(emptyMeta.body.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const typed = await postPayment(app, apiKey, "meta-type-key", {
      amount: 100,
      currency: "NGN",
      paymentMethod: { type: "card", token: "tok_4242" },
      metadata: { flag: 1 },
    });
    const retyped = await postPayment(app, apiKey, "meta-type-key", {
      amount: 100,
      currency: "NGN",
      paymentMethod: { type: "card", token: "tok_4242" },
      metadata: { flag: true },
    });
    expect(typed.status).toBe(202);
    expect(retyped.status).toBe(422);
  });

  it("honors If-Match forms and blocks every illegal client transition", async () => {
    const { app, apiKey, container } = await createTestApp();
    const created = await postPayment(app, apiKey, "edge-cancel-key");
    const id = created.body.id as string;
    const patch = (payload: object, ifMatch?: string) => {
      const call = request(app)
        .patch(`/api/v1/payments/${id}/status`)
        .set("X-Api-Key", apiKey)
        .set("Content-Type", "application/json");
      if (ifMatch !== undefined) {
        call.set("If-Match", ifMatch);
      }
      return call.send(payload);
    };

    expect((await patch({ status: "CANCELLED", reason: "" })).status).toBe(400);
    expect(
      (await patch({ status: "CANCELLED", reason: "r".repeat(256) })).status,
    ).toBe(400);
    expect((await patch({ status: "REFUNDED" })).status).toBe(409);
    expect((await patch({ status: "FAILED" })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    for (const header of ["", "1.0", 'W/"1"', "1e1"]) {
      const response = await patch({ status: "CANCELLED" }, header);
      expect(response.status).toBe(400);
      expect(response.body.detail).toMatch(/If-Match/);
    }
    const stale = await patch({ status: "CANCELLED" }, "0");
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const still = await request(app)
      .get(`/api/v1/payments/${id}`)
      .set("X-Api-Key", apiKey);
    expect(still.body).toMatchObject({ status: "PENDING", version: 1 });

    const cancelled = await patch(
      { status: "CANCELLED", reason: "r".repeat(255) },
      '"1"',
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.statusReason).toHaveLength(255);
    const padded = await postPayment(app, apiKey, "edge-padded-version");
    const paddedCancel = await request(app)
      .patch(`/api/v1/payments/${padded.body.id}/status`)
      .set("X-Api-Key", apiKey)
      .set("If-Match", "  01  ")
      .set("Content-Type", "application/json")
      .send({ status: "CANCELLED" });
    expect(paddedCancel.status).toBe(200);
    expect(paddedCancel.body.statusReason).toBeNull();

    const processing = await postPayment(app, apiKey, "edge-processing");
    await forceStatus(
      container.repository,
      processing.body.id as string,
      "PROCESSING",
    );
    const blocked = await request(app)
      .patch(`/api/v1/payments/${processing.body.id}/status`)
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .send({ status: "CANCELLED" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("INVALID_TRANSITION");

    const succeeded = await postPayment(app, apiKey, "edge-succeeded");
    await forceStatus(
      container.repository,
      succeeded.body.id as string,
      "SUCCEEDED",
    );
    const cancelSettled = await request(app)
      .patch(`/api/v1/payments/${succeeded.body.id}/status`)
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .send({ status: "CANCELLED" });
    expect(cancelSettled.status).toBe(409);
    const refunded = await request(app)
      .patch(`/api/v1/payments/${succeeded.body.id}/status`)
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .send({ status: "REFUNDED" });
    expect(refunded.status).toBe(200);
    const again = await request(app)
      .patch(`/api/v1/payments/${succeeded.body.id}/status`)
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .send({ status: "REFUNDED" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("INVALID_TRANSITION");

    const failed = await postPayment(app, apiKey, "edge-failed");
    await forceStatus(
      container.repository,
      failed.body.id as string,
      "FAILED",
      {
        failureReason: "PAYMENT_DECLINED",
      },
    );
    const refundFailed = await request(app)
      .patch(`/api/v1/payments/${failed.body.id}/status`)
      .set("X-Api-Key", apiKey)
      .set("Content-Type", "application/json")
      .send({ status: "REFUNDED" });
    expect(refundFailed.status).toBe(409);

    const foreign = await request(app)
      .patch(`/api/v1/payments/${id}/status`)
      .set("X-Api-Key", "merchant-key")
      .set("Content-Type", "application/json")
      .send({ status: "REFUNDED" });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("PAYMENT_NOT_FOUND");
  });

  it("pages with the documented limit and offset bounds", async () => {
    const { app, apiKey } = await createTestApp();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await postPayment(app, apiKey, `page-key-${index}`, {
        ...body,
        amount: 100 + index,
      });
      ids.push(created.body.id as string);
    }
    const defaults = await request(app)
      .get("/api/v1/payments")
      .set("X-Api-Key", apiKey);
    expect(defaults.body.page).toEqual({ limit: 20, offset: 0, total: 3 });
    const ordered = defaults.body.data as Array<{
      id: string;
      createdAt: string;
    }>;
    expect(new Set(ordered.map((row) => row.id))).toEqual(new Set(ids));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (!previous || !current) {
        throw new Error("missing page row");
      }
      const byTime = previous.createdAt.localeCompare(current.createdAt);
      expect(
        byTime > 0 ||
          (byTime === 0 && previous.id.localeCompare(current.id) <= 0),
      ).toBe(true);
    }

    const middle = await request(app)
      .get("/api/v1/payments")
      .query({ limit: 1, offset: 1 })
      .set("X-Api-Key", apiKey);
    expect(middle.body.page.total).toBe(3);
    expect(middle.body.data).toHaveLength(1);
    expect(middle.body.data[0].id).toBe(ordered[1]?.id);

    const past = await request(app)
      .get("/api/v1/payments")
      .query({ limit: 100, offset: 3 })
      .set("X-Api-Key", apiKey);
    expect(past.status).toBe(200);
    expect(past.body).toMatchObject({
      data: [],
      page: { total: 3, offset: 3 },
    });

    const none = await request(app)
      .get("/api/v1/payments")
      .query({ status: "FAILED" })
      .set("X-Api-Key", apiKey);
    expect(none.body).toMatchObject({ data: [], page: { total: 0 } });

    const scientific = await request(app)
      .get("/api/v1/payments")
      .query({ limit: "1e2", offset: "0" })
      .set("X-Api-Key", apiKey);
    expect(scientific.status).toBe(200);
    expect(scientific.body.page.limit).toBe(100);

    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { limit: "1.5" },
      { status: "" },
      { status: "pending" },
    ]) {
      const response = await request(app)
        .get("/api/v1/payments")
        .query(query)
        .set("X-Api-Key", apiKey);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    }
  });

  it("accepts only a JSON content type and a request id of at most 128 characters", async () => {
    const { app, apiKey } = await createTestApp();
    const charset = await postPayment(
      app,
      apiKey,
      "charset-key-ok",
      body,
      "application/json; charset=utf-8",
    );
    expect(charset.status).toBe(202);
    const upper = await postPayment(
      app,
      apiKey,
      "charset-key-upper",
      body,
      "Application/JSON;charset=UTF-8",
    );
    expect(upper.status).toBe(202);
    const extra = await postPayment(
      app,
      apiKey,
      "charset-key-extra",
      JSON.stringify(body),
      "application/json; charset=utf-8; extra=1",
    );
    expect(extra.status).toBe(415);
    const utf16 = await postPayment(
      app,
      apiKey,
      "charset-key-utf16",
      JSON.stringify(body),
      "application/json; charset=utf-16",
    );
    expect(utf16.status).toBe(415);
    const firstOfMany = await postPayment(
      app,
      apiKey,
      "charset-key-multi",
      JSON.stringify(body),
      "application/json, text/plain",
    );
    expect(firstOfMany.status).toBe(400);
    expect(firstOfMany.body.errors[0].message).toMatch(/expected object/);
    const reversed = await postPayment(
      app,
      apiKey,
      "charset-key-reversed",
      JSON.stringify(body),
      "text/plain, application/json",
    );
    expect(reversed.status).toBe(415);

    const empty = await postPayment(app, apiKey, "empty-object-key", {});
    expect(empty.status).toBe(400);
    expect(empty.body.errors.length).toBeGreaterThan(0);
    const array = await postPayment(app, apiKey, "array-body-key", "[1,2]");
    expect(array.status).toBe(400);
    const nullBody = await postPayment(app, apiKey, "null-body-key", "null");
    expect(nullBody.status).toBe(400);

    const exact = "a".repeat(128);
    const echoed = await request(app)
      .get("/api/v1/payments/not-a-uuid")
      .set("X-Api-Key", apiKey)
      .set("X-Request-Id", exact);
    expect(echoed.headers["x-request-id"]).toBe(exact);
    expect(echoed.body.requestId).toBe(exact);
    const tooLong = "b".repeat(129);
    const replaced = await request(app)
      .get("/api/v1/payments/not-a-uuid")
      .set("X-Api-Key", apiKey)
      .set("X-Request-Id", tooLong);
    expect(replaced.headers["x-request-id"]).not.toBe(tooLong);
    expect(replaced.body.requestId).toBe(replaced.headers["x-request-id"]);
    expect(replaced.headers["x-request-id"]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    const hostile = await request(app)
      .get("/health/live")
      .set("X-Request-Id", "trace.id");
    expect(hostile.headers["x-request-id"]).not.toBe("trace.id");
    expect(hostile.headers["x-request-id"]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it("records timeout and unknown gateway failures without leaking the cause", async () => {
    const timeout = await createTestApp({
      gateway: new ScriptedGateway(["timeout"]),
      startQueue: true,
      env: { PAYMENT_MAX_ATTEMPTS: "1" },
    });
    try {
      const created = await postPayment(
        timeout.app,
        timeout.apiKey,
        "timeout-edge-key",
      );
      await waitFor(async () => {
        const response = await request(timeout.app)
          .get(`/api/v1/payments/${created.body.id}`)
          .set("X-Api-Key", timeout.apiKey);
        return response.body.status === "FAILED";
      });
      const stored = await request(timeout.app)
        .get(`/api/v1/payments/${created.body.id}`)
        .set("X-Api-Key", timeout.apiKey);
      expect(stored.body).toMatchObject({
        status: "FAILED",
        failureReason: "GATEWAY_TIMEOUT",
        attempts: 1,
      });
    } finally {
      timeout.container.queue.pause();
    }

    const unknown = await createTestApp({
      gateway: {
        async charge() {
          throw new Error("socket hang up secret");
        },
      },
      startQueue: true,
      env: { PAYMENT_MAX_ATTEMPTS: "1" },
    });
    try {
      const created = await postPayment(
        unknown.app,
        unknown.apiKey,
        "unknown-edge-key",
      );
      await waitFor(async () => {
        const response = await request(unknown.app)
          .get(`/api/v1/payments/${created.body.id}`)
          .set("X-Api-Key", unknown.apiKey);
        return response.body.status === "FAILED";
      });
      const stored = await request(unknown.app)
        .get(`/api/v1/payments/${created.body.id}`)
        .set("X-Api-Key", unknown.apiKey);
      expect(stored.body).toMatchObject({
        status: "FAILED",
        failureReason: "GATEWAY_UNAVAILABLE",
        attempts: 1,
      });
      expect(JSON.stringify(stored.body)).not.toContain("socket hang up");
    } finally {
      unknown.container.queue.pause();
    }
  });
});

async function forceStatus(
  repository: PaymentRepository,
  id: string,
  status: PaymentStatus,
  extra: { failureReason?: FailureReason } = {},
): Promise<Payment> {
  return repository.withTransaction(async (tx) => {
    const current = await tx.findByIdForUpdate(id);
    if (!current) {
      throw new Error("missing payment");
    }
    return tx.update(
      {
        ...current,
        status,
        failureReason: extra.failureReason ?? current.failureReason,
        processingStartedAt: status === "PROCESSING" ? current.updatedAt : null,
        version: current.version + 1,
      },
      current.version,
    );
  });
}
