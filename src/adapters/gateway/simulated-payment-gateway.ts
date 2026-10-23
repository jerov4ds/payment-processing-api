import {
  GatewayTimeoutError,
  GatewayUnavailableError,
  PaymentDeclinedError,
} from "../../domain/errors";
import type { Sleeper } from "../../ports/clock";
import type {
  ChargeCommand,
  PaymentGateway,
} from "../../ports/payment-gateway";

export interface SimulatedGatewayOptions {
  seed: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  transientFailureRate: number;
  permanentFailureRate: number;
  sleeper: Sleeper;
}

export type GatewayDecision = "approved" | "declined" | "unavailable";

export class SimulatedPaymentGateway implements PaymentGateway {
  constructor(private readonly options: SimulatedGatewayOptions) {}

  async charge(command: ChargeCommand): Promise<{ approved: true }> {
    const latency = latencyMs(this.options, command);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new GatewayTimeoutError()),
      command.timeoutMs,
    );
    try {
      await this.options.sleeper.sleep(latency, controller.signal);
    } catch {
      throw new GatewayTimeoutError();
    } finally {
      clearTimeout(timer);
    }
    const decision = decideOutcome({
      seed: this.options.seed,
      paymentId: command.paymentId,
      attempt: command.attempt,
      permanentRate: this.options.permanentFailureRate,
      transientRate: this.options.transientFailureRate,
    });
    if (decision === "declined") {
      throw new PaymentDeclinedError();
    }
    if (decision === "unavailable") {
      throw new GatewayUnavailableError();
    }
    return { approved: true };
  }
}

export function decideOutcome(input: {
  seed: number;
  paymentId: string;
  attempt: number;
  permanentRate: number;
  transientRate: number;
}): GatewayDecision {
  const roll = unitHash(
    input.seed,
    `${input.paymentId}:${input.attempt}:outcome`,
  );
  if (roll < input.permanentRate) {
    return "declined";
  }
  if (roll < input.permanentRate + input.transientRate) {
    return "unavailable";
  }
  return "approved";
}

export function latencyMs(
  options: SimulatedGatewayOptions,
  command: ChargeCommand,
): number {
  if (options.maxLatencyMs <= options.minLatencyMs) {
    return options.minLatencyMs;
  }
  const roll = unitHash(
    options.seed,
    `${command.paymentId}:${command.attempt}:latency`,
  );
  return Math.round(
    options.minLatencyMs + roll * (options.maxLatencyMs - options.minLatencyMs),
  );
}

function unitHash(seed: number, value: string): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}
