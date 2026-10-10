const FIRST_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

/**
 * Retries failed loads, one pending retry per key: on the browser's
 * `online` event or after a backoff that doubles per failure, whichever
 * comes first. Most failures are a dropped connection, but `online` never
 * fires for a flaky one or a server error, hence the timer as well.
 *
 * The callback should check that what failed is still wanted; nothing
 * cancels a retry when the file it was for goes away.
 */
export class RetryQueue {
  private readonly failures = new Map<string, number>();
  private readonly waiting = new Map<string, () => void>();
  private disposed = false;

  schedule(key: string, run: () => void): void {
    if (this.disposed || this.waiting.has(key)) return;
    const failures = this.failures.get(key) ?? 0;
    this.failures.set(key, failures + 1);
    const abort = new AbortController();
    const cancel = () => {
      clearTimeout(timer);
      abort.abort();
      this.waiting.delete(key);
    };
    const fire = () => {
      cancel();
      run();
    };
    const timer = setTimeout(
      fire,
      Math.min(FIRST_DELAY_MS * 2 ** failures, MAX_DELAY_MS),
    );
    window.addEventListener("online", fire, {
      once: true,
      signal: abort.signal,
    });
    this.waiting.set(key, cancel);
  }

  /** Resets the backoff for `key`. */
  succeeded(key: string): void {
    this.failures.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of [...this.waiting.values()]) cancel();
    this.failures.clear();
  }
}
