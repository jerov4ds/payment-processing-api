import { InProcessJobQueue } from "../../../src/adapters/queue/in-process-job-queue";
import { SystemClock } from "../../../src/ports/clock";
import { FakeClock, deferred, waitFor } from "../../helpers/fixtures";

describe("in-process job queue", () => {
  it("runs due jobs up to the concurrency limit", async () => {
    const clock = new FakeClock();
    const queue = new InProcessJobQueue(clock, 1, () => undefined);
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const release = deferred<void>();
    const started: Array<ReturnType<typeof deferred<void>>> = [];
    queue.start(async (paymentId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(paymentId);
      const gate = deferred<void>();
      started.push(gate);
      gate.resolve();
      await release.promise;
      active -= 1;
    });
    queue.enqueue({ paymentId: "a", runAt: clock.now() });
    queue.enqueue({ paymentId: "b", runAt: clock.now() });
    await started[0]?.promise;
    expect(order).toEqual(["a"]);
    expect(maxActive).toBe(1);
    release.resolve();
    await waitFor(() => order.length === 2);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["a", "b"]);
    const drained = await queue.drain(1000);
    expect(drained).toEqual({ drained: true, inflight: 0 });
  });

  it("holds one waiting job per payment and keeps the earliest runAt", async () => {
    const clock = new FakeClock();
    const queue = new InProcessJobQueue(clock, 1, () => undefined);
    const ran: string[] = [];
    queue.enqueue({
      paymentId: "a",
      runAt: new Date(clock.now().getTime() + 500),
    });
    queue.enqueue({ paymentId: "a", runAt: clock.now() });
    queue.enqueue({
      paymentId: "a",
      runAt: new Date(clock.now().getTime() + 900),
    });
    queue.start(async (paymentId) => {
      ran.push(paymentId);
    });
    await waitFor(() => ran.length === 1);
    clock.advance(1_000);
    queue.enqueue({ paymentId: "b", runAt: clock.now() });
    await waitFor(() => ran.length === 2);
    expect(ran).toEqual(["a", "b"]);
    await queue.drain(1000);
  });

  it("accepts a new job for a payment whose job is running", async () => {
    const clock = new FakeClock();
    const queue = new InProcessJobQueue(clock, 2, () => undefined);
    const ran: string[] = [];
    queue.start(async (paymentId) => {
      ran.push(paymentId);
      if (ran.length === 1) {
        queue.enqueue({ paymentId, runAt: clock.now() });
      }
    });
    queue.enqueue({ paymentId: "a", runAt: clock.now() });
    await waitFor(() => ran.length === 2);
    expect(ran).toEqual(["a", "a"]);
    await queue.drain(1000);
  });

  it("waits until runAt before starting a delayed job", async () => {
    const clock = new SystemClock();
    const queue = new InProcessJobQueue(clock, 1, () => undefined);
    let ran = false;
    queue.start(async () => {
      ran = true;
    });
    queue.enqueue({ paymentId: "later", runAt: new Date(Date.now() + 40) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ran).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ran).toBe(true);
    queue.pause();
  });

  it("reports a drain timeout while a job is still running", async () => {
    const queue = new InProcessJobQueue(new FakeClock(), 1, () => undefined);
    const release = deferred<void>();
    const started = deferred<void>();
    queue.start(async () => {
      started.resolve();
      await release.promise;
    });
    queue.enqueue({ paymentId: "stuck", runAt: new FakeClock().now() });
    await started.promise;
    await expect(queue.drain(30)).resolves.toEqual({
      drained: false,
      inflight: 1,
    });
    release.resolve();
    await queue.drain(1000);
  });

  it("reports handler failures without dropping the worker slot", async () => {
    const errors: unknown[] = [];
    const queue = new InProcessJobQueue(new FakeClock(), 1, (error) => {
      errors.push(error);
    });
    queue.start(async () => {
      throw new Error("handler failed");
    });
    queue.enqueue({ paymentId: "bad", runAt: new FakeClock().now() });
    await queue.drain(1000);
    expect(errors).toHaveLength(1);
  });
});
