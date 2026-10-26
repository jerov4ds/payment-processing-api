import type { Clock } from "../../ports/clock";
import type { JobQueue, QueueJob } from "../../ports/job-queue";

interface ScheduledJob {
  paymentId: string;
  runAtMs: number;
}

export class InProcessJobQueue implements JobQueue {
  private jobs: ScheduledJob[] = [];
  private handler: ((paymentId: string) => Promise<void>) | null = null;
  private started = false;
  private paused = false;
  private inflight = 0;
  private activeWorkers = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly concurrency: number,
    private readonly onError: (error: unknown, paymentId: string) => void,
  ) {}

  /** A payment has at most one waiting job. A second enqueue keeps the earlier runAt. */
  enqueue(job: QueueJob): void {
    const runAtMs = job.runAt.getTime();
    const waiting = this.jobs.find(
      (existing) => existing.paymentId === job.paymentId,
    );
    if (waiting) {
      waiting.runAtMs = Math.min(waiting.runAtMs, runAtMs);
    } else {
      this.jobs.push({ paymentId: job.paymentId, runAtMs });
    }
    this.kick();
  }

  start(handler: (paymentId: string) => Promise<void>): void {
    this.handler = handler;
    this.started = true;
    this.paused = false;
    this.kick();
  }

  pause(): void {
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async drain(
    timeoutMs: number,
  ): Promise<{ drained: boolean; inflight: number }> {
    this.pause();
    const deadline = Date.now() + timeoutMs;
    while (this.inflight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { drained: this.inflight === 0, inflight: this.inflight };
  }

  private kick(): void {
    if (!this.started || this.paused || !this.handler) {
      return;
    }
    this.launchDue();
    this.armTimer();
  }

  private launchDue(): void {
    const now = this.clock.now().getTime();
    while (this.activeWorkers < this.concurrency) {
      const job = this.takeNextDue(now);
      if (!job) {
        break;
      }
      this.runOne(job.paymentId);
    }
  }

  private takeNextDue(now: number): ScheduledJob | undefined {
    let bestIndex = -1;
    let bestTime = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.jobs.length; index += 1) {
      const job = this.jobs[index];
      if (!job || job.runAtMs > now || job.runAtMs >= bestTime) {
        continue;
      }
      bestTime = job.runAtMs;
      bestIndex = index;
    }
    if (bestIndex < 0) {
      return undefined;
    }
    return this.jobs.splice(bestIndex, 1)[0];
  }

  private runOne(paymentId: string): void {
    const handler = this.handler;
    if (!handler) {
      return;
    }
    this.inflight += 1;
    this.activeWorkers += 1;
    void handler(paymentId)
      .catch((error: unknown) => {
        this.onError(error, paymentId);
      })
      .finally(() => {
        this.inflight -= 1;
        this.activeWorkers -= 1;
        this.kick();
      });
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.started || this.paused) {
      return;
    }
    const now = this.clock.now().getTime();
    let nextAt = Number.POSITIVE_INFINITY;
    for (const job of this.jobs) {
      if (job.runAtMs > now && job.runAtMs < nextAt) {
        nextAt = job.runAtMs;
      }
    }
    if (!Number.isFinite(nextAt)) {
      return;
    }
    const delay = Math.max(0, nextAt - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, delay);
    this.timer.unref();
  }
}
