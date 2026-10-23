import {
  SimulatedPaymentGateway,
  decideOutcome,
  latencyMs,
} from "../../../src/adapters/gateway/simulated-payment-gateway";
import {
  GatewayTimeoutError,
  GatewayUnavailableError,
  PaymentDeclinedError,
} from "../../../src/domain/errors";
import type { Sleeper } from "../../../src/ports/clock";

class RecordingSleeper implements Sleeper {
  sleeps: number[] = [];

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("aborted");
    }
  }
}

const command = {
  paymentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  amount: 100,
  currency: "NGN",
  attempt: 1,
  timeoutMs: 1000,
};

describe("simulated payment gateway", () => {
  it("returns the same decision for the same seed, payment, and attempt", () => {
    const input = {
      seed: 7,
      paymentId: command.paymentId,
      attempt: 1,
      permanentRate: 0.25,
      transientRate: 0.25,
    };
    expect(decideOutcome(input)).toBe(decideOutcome(input));
    const other = new SimulatedPaymentGateway({
      seed: 7,
      minLatencyMs: 0,
      maxLatencyMs: 0,
      transientFailureRate: 0.25,
      permanentFailureRate: 0.25,
      sleeper: new RecordingSleeper(),
    });
    const again = new SimulatedPaymentGateway({
      seed: 7,
      minLatencyMs: 0,
      maxLatencyMs: 0,
      transientFailureRate: 0.25,
      permanentFailureRate: 0.25,
      sleeper: new RecordingSleeper(),
    });
    expect(other).toBeInstanceOf(SimulatedPaymentGateway);
    expect(again).toBeInstanceOf(SimulatedPaymentGateway);
  });

  it("approves, declines, or reports unavailable from the configured rates", async () => {
    const sleeper = new RecordingSleeper();
    const approved = new SimulatedPaymentGateway({
      seed: 1,
      minLatencyMs: 0,
      maxLatencyMs: 0,
      transientFailureRate: 0,
      permanentFailureRate: 0,
      sleeper,
    });
    await expect(approved.charge(command)).resolves.toEqual({ approved: true });

    const declined = new SimulatedPaymentGateway({
      seed: 1,
      minLatencyMs: 0,
      maxLatencyMs: 0,
      transientFailureRate: 0,
      permanentFailureRate: 1,
      sleeper,
    });
    await expect(declined.charge(command)).rejects.toBeInstanceOf(
      PaymentDeclinedError,
    );

    const unavailable = new SimulatedPaymentGateway({
      seed: 1,
      minLatencyMs: 0,
      maxLatencyMs: 0,
      transientFailureRate: 1,
      permanentFailureRate: 0,
      sleeper,
    });
    await expect(unavailable.charge(command)).rejects.toBeInstanceOf(
      GatewayUnavailableError,
    );
  });

  it("times out when the simulated latency exceeds the call timeout", async () => {
    const gateway = new SimulatedPaymentGateway({
      seed: 1,
      minLatencyMs: 1_000,
      maxLatencyMs: 1_000,
      transientFailureRate: 0,
      permanentFailureRate: 0,
      sleeper: {
        async sleep(ms, signal) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("aborted"),
                );
              },
              { once: true },
            );
          });
        },
      },
    });
    await expect(
      gateway.charge({ ...command, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(GatewayTimeoutError);
  });

  it("chooses a deterministic latency inside the configured window", () => {
    const options = {
      seed: 3,
      minLatencyMs: 10,
      maxLatencyMs: 40,
      transientFailureRate: 0,
      permanentFailureRate: 0,
      sleeper: new RecordingSleeper(),
    };
    const first = latencyMs(options, command);
    const second = latencyMs(options, command);
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(10);
    expect(first).toBeLessThanOrEqual(40);
  });
});
