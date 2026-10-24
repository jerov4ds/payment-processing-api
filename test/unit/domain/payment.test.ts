import {
  InvalidTransitionError,
  ValidationError,
} from "../../../src/domain/errors";
import {
  applyClientTransition,
  claimForProcessing,
  copyMetadata,
  createPayment,
  leaseExpired,
  markFailed,
  markSucceeded,
  releaseForRetry,
} from "../../../src/domain/payment";
import { MAX_AMOUNT, MIN_AMOUNT } from "../../../src/domain/money";
import { NOW, PAYMENT_ID, samplePayment } from "../../helpers/fixtures";

const base = {
  id: PAYMENT_ID,
  clientId: "demo",
  amount: 150000,
  currency: "NGN",
  idempotencyKey: "order-1042-key",
  paymentMethod: { type: "card", token: "tok_visa_4242" },
  now: NOW,
};

describe("payment aggregate", () => {
  it("stores minor units and only the masked payment method", () => {
    const metadata = { orderId: "1042" };
    const payment = createPayment({
      ...base,
      description: "Order 1042",
      metadata,
    });
    metadata.orderId = "changed";
    expect(payment).toMatchObject({
      amount: 150000,
      currency: "NGN",
      status: "PENDING",
      version: 1,
      attempts: 0,
      paymentMethod: { type: "card", last4: "4242" },
      metadata: { orderId: "1042" },
      failureReason: null,
    });
    expect(JSON.stringify(payment)).not.toContain("tok_visa");
  });

  it("rejects floats, out-of-range amounts, unknown currencies, and raw-looking tokens", () => {
    expect(() => createPayment({ ...base, amount: 10.5 })).toThrow(
      ValidationError,
    );
    expect(() => createPayment({ ...base, amount: 0 })).toThrow(
      ValidationError,
    );
    expect(() => createPayment({ ...base, amount: MAX_AMOUNT + 1 })).toThrow(
      ValidationError,
    );
    expect(() => createPayment({ ...base, currency: "JPY" })).toThrow(
      /Unsupported currency/,
    );
    expect(() =>
      createPayment({
        ...base,
        paymentMethod: { type: "card", token: "4242424242424242" },
      }),
    ).toThrow(/card number/);
    expect(() =>
      createPayment({ ...base, paymentMethod: { type: "card", token: "no" } }),
    ).toThrow(/token/);
    expect(() => createPayment({ ...base, clientId: "bad id" })).toThrow(
      /Invalid API client/,
    );
    expect(() =>
      createPayment({
        ...base,
        paymentMethod: { type: "cash", token: "tok_4242" },
      }),
    ).toThrow(/payment method/);
  });

  it("drops prototype keys from metadata and treats a missing lease as expired", () => {
    const metadata = copyMetadata({ orderId: "1042", constructor: "x" });
    expect(metadata.orderId).toBe("1042");
    expect(Object.keys(metadata)).not.toContain("constructor");
    const pending = createPayment(base);
    expect(leaseExpired(pending, NOW, 1_000)).toBe(false);
    const processing = {
      ...pending,
      status: "PROCESSING" as const,
      processingStartedAt: null,
    };
    expect(leaseExpired(processing, NOW, 1_000)).toBe(true);
  });

  it("accepts both amount ends, every method, and tokens just outside a PAN", () => {
    expect(createPayment({ ...base, amount: MIN_AMOUNT }).amount).toBe(1);
    expect(createPayment({ ...base, amount: MAX_AMOUNT }).amount).toBe(
      MAX_AMOUNT,
    );
    expect(createPayment({ ...base, amount: 1.0 }).amount).toBe(1);
    const shortToken = createPayment({
      ...base,
      paymentMethod: { type: "wallet", token: "tok1" },
    });
    expect(shortToken.paymentMethod).toEqual({ type: "wallet", last4: "tok1" });
    const longest = "a".repeat(64);
    expect(
      createPayment({
        ...base,
        paymentMethod: { type: "bank_transfer", token: longest },
      }).paymentMethod,
    ).toEqual({ type: "bank_transfer", last4: "aaaa" });
    const twelve = "123456789012";
    const twenty = "12345678901234567890";
    expect(
      createPayment({
        ...base,
        paymentMethod: { type: "card", token: twelve },
      }).paymentMethod.last4,
    ).toBe("9012");
    expect(
      JSON.stringify(
        createPayment({
          ...base,
          paymentMethod: { type: "card", token: twenty },
        }),
      ),
    ).not.toContain(twenty);
    expect(
      createPayment({ ...base, clientId: "a".repeat(64) }).clientId,
    ).toHaveLength(64);
    expect(
      createPayment({ ...base, clientId: "demo.merchant_1" }).clientId,
    ).toBe("demo.merchant_1");
    expect(createPayment(base).description).toBeNull();
  });

  it("rejects amounts and tokens on the wrong side of each boundary", () => {
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      expect(() => createPayment({ ...base, amount })).toThrow(ValidationError);
    }
    expect(() => createPayment({ ...base, clientId: "" })).toThrow(
      /Invalid API client/,
    );
    expect(() => createPayment({ ...base, clientId: "a".repeat(65) })).toThrow(
      /Invalid API client/,
    );
    expect(() => createPayment({ ...base, clientId: "bad/id" })).toThrow(
      /Invalid API client/,
    );
    for (const token of [
      "abc",
      "a".repeat(65),
      "1234567890123",
      "1".repeat(19),
    ]) {
      expect(() =>
        createPayment({ ...base, paymentMethod: { type: "card", token } }),
      ).toThrow(ValidationError);
    }
    expect(() =>
      createPayment({
        ...base,
        paymentMethod: { type: "card", token: "1".repeat(19) },
      }),
    ).toThrow(/card number/);
    expect(() =>
      createPayment({
        ...base,
        paymentMethod: { type: "card", token: "has space" },
      }),
    ).toThrow(/token/);
  });

  it("expires a processing lease on the exact boundary and ignores other statuses", () => {
    const started = new Date("2026-01-15T12:00:00.000Z");
    const processing = samplePayment({
      status: "PROCESSING",
      processingStartedAt: started.toISOString(),
    });
    expect(
      leaseExpired(processing, new Date(started.getTime() + 4_999), 5_000),
    ).toBe(false);
    expect(
      leaseExpired(processing, new Date(started.getTime() + 5_000), 5_000),
    ).toBe(true);
    expect(
      leaseExpired(
        { ...processing, status: "SUCCEEDED" },
        new Date(started.getTime() + 60_000),
        5_000,
      ),
    ).toBe(false);
    expect(leaseExpired(processing, started, 0)).toBe(true);
  });

  it("drops prototype keys and keeps worker transitions from rewriting history", () => {
    const metadata = Object.create(null) as Record<string, string>;
    metadata["prototype"] = "nope";
    metadata["__proto__"] = "nope";
    metadata["constructor"] = "nope";
    metadata["orderId"] = "1042";
    const payment = createPayment({ ...base, metadata });
    expect(Object.keys(payment.metadata)).toEqual(["orderId"]);
    expect(copyMetadata(metadata).constructor).toBeUndefined();

    const processing = {
      ...claimForProcessing(samplePayment(), NOW),
      failureReason: "GATEWAY_TIMEOUT" as const,
    };
    const succeeded = markSucceeded(processing, NOW);
    expect(succeeded).toMatchObject({
      status: "SUCCEEDED",
      failureReason: null,
      processingStartedAt: null,
      attempts: 1,
    });
    const refunded = applyClientTransition(
      succeeded,
      { status: "REFUNDED" },
      NOW,
    );
    expect(refunded.statusReason).toBeNull();
    processing.metadata.orderId = "changed";
    expect(succeeded.metadata.orderId).toBe("1042");
    expect(() => releaseForRetry(succeeded, NOW)).toThrow(
      InvalidTransitionError,
    );
    expect(() => markFailed(samplePayment(), "PAYMENT_DECLINED", NOW)).toThrow(
      InvalidTransitionError,
    );
    expect(() =>
      claimForProcessing(samplePayment({ status: "CANCELLED" }), NOW),
    ).toThrow(InvalidTransitionError);
  });
});
