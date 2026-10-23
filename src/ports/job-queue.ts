export interface QueueJob {
  paymentId: string;
  runAt: Date;
}

export interface JobQueue {
  enqueue(job: QueueJob): void;
  start(handler: (paymentId: string) => Promise<void>): void;
  pause(): void;
  drain(timeoutMs: number): Promise<{ drained: boolean; inflight: number }>;
}
