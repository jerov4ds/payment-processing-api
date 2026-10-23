import { randomUUID } from "node:crypto";

export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface IdGenerator {
  uuid(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class SystemSleeper implements Sleeper {
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    if (ms <= 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

export class SystemIds implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new Error("aborted");
}
