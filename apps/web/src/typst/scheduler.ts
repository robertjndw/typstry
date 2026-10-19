export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultClock: SchedulerClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  delayMs?: number;
  /**
   * "debounce": run `delayMs` after the last request (trailing edge only).
   * "throttle": run right away when the last run started at least `delayMs`
   * ago, otherwise at that point; requests in between collapse into one.
   */
  mode?: "debounce" | "throttle";
  clock?: SchedulerClock;
}

/**
 * Runs the latest requested value, with at most one job running and at most
 * one waiting behind it. Older requests that never started are dropped.
 */
export class CompileScheduler<T> {
  private timer: unknown = null;
  private pending: { value: T } | null = null;
  private running = false;
  private queued: { value: T } | null = null;
  private lastStart = Number.NEGATIVE_INFINITY;
  private readonly run: (value: T) => Promise<void>;
  private readonly delayMs: number;
  private readonly mode: "debounce" | "throttle";
  private readonly clock: SchedulerClock;

  constructor(
    run: (value: T) => Promise<void>,
    options: SchedulerOptions = {},
  ) {
    this.run = run;
    this.delayMs = options.delayMs ?? 200;
    this.mode = options.mode ?? "debounce";
    this.clock = options.clock ?? defaultClock;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** A request is scheduled or queued behind the running job. */
  get hasWaiting(): boolean {
    return this.pending !== null || this.queued !== null;
  }

  request(value: T): void {
    this.pending = { value };
    if (this.mode === "debounce") {
      if (this.timer !== null) this.clock.clearTimeout(this.timer);
      this.timer = this.clock.setTimeout(() => this.fire(), this.delayMs);
      return;
    }
    if (this.timer !== null) return; // already scheduled; it picks up the latest
    const wait = Math.max(0, this.lastStart + this.delayMs - this.clock.now());
    // Never started right here, even with no wait. In the worker a request
    // is a message, and a job blocks the thread: started inside the first
    // keystroke's message, it left the next keystrokes' messages waiting
    // until it was done, then took them one per job, so the preview
    // replayed the typing letter by letter. A timer runs once the messages
    // already queued are handled, so the job gets the latest text.
    this.timer = this.clock.setTimeout(() => this.fire(), wait);
  }

  /** Drops the scheduled and queued requests; a running job finishes. */
  cancel(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.queued = null;
  }

  private fire(): void {
    this.timer = null;
    const next = this.pending;
    this.pending = null;
    if (!next) return;
    if (this.running) this.queued = next;
    else void this.start(next.value);
  }

  private async start(value: T): Promise<void> {
    this.running = true;
    this.lastStart = this.clock.now();
    try {
      await this.run(value);
    } catch (err) {
      // The run callback reports its own errors; this only keeps the queue
      // alive if it throws anyway.
      console.error("compile job failed", err);
    } finally {
      this.running = false;
      const next = this.queued;
      this.queued = null;
      // Through a timer for the same reason as in request(): the edits made
      // during the job are still waiting as messages.
      if (next) {
        this.pending ??= next;
        this.timer ??= this.clock.setTimeout(() => this.fire(), 0);
      }
    }
  }
}
