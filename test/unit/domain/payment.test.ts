import { ValidationError } from "../../../src/domain/errors";
import {
  copyMetadata,
  createPayment,
  leaseExpired,
} from "../../../src/domain/payment";
import { MAX_AMOUNT } from "../../../src/domain/money";
import { NOW, PAYMENT_ID } from "../../helpers/fixtures";

const base = {
  id: PAYMENT_ID,
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
});
