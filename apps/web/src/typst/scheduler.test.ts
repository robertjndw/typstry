import { CompileScheduler, type SchedulerClock } from "./scheduler";

/** Manual clock: timers fire only from advance(). */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: SchedulerClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = target;
    await flush();
  }
  return { clock, advance };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A run function whose jobs finish only when the test says so. */
function controlledRun() {
  const started: string[] = [];
  const finishers: (() => void)[] = [];
  const run = (value: string) => {
    started.push(value);
    return new Promise<void>((resolve) => finishers.push(resolve));
  };
  const finish = async () => {
    finishers.shift()?.();
    await flush();
  };
  return { run, started, finish };
}

describe("CompileScheduler (debounce)", () => {
  it("runs once, with the latest value, after the delay", async () => {
    const { clock, advance } = fakeClock();
    const { run, started } = controlledRun();
    const s = new CompileScheduler(run, { delayMs: 200, clock });
    s.request("a");
    await advance(100);
    s.request("b");
    await advance(150);
    expect(started).toEqual([]);
    s.request("c");
    await advance(199);
    expect(started).toEqual([]);
    await advance(1);
    expect(started).toEqual(["c"]);
  });

  it("keeps one running and one queued, latest wins", async () => {
    const { clock, advance } = fakeClock();
    const { run, started, finish } = controlledRun();
    const s = new CompileScheduler(run, { delayMs: 200, clock });
    s.request("a");
    await advance(200);
    expect(started).toEqual(["a"]);

    s.request("b");
    await advance(200);
    s.request("c");
    await advance(200);
    s.request("d");
    await advance(200);
    expect(started).toEqual(["a"]);

    await finish();
    await advance(0);
    expect(started).toEqual(["a", "d"]);
    await finish();
    await advance(0);
    expect(started).toEqual(["a", "d"]);
  });

  it("cancel drops scheduled and queued work but not the running job", async () => {
    const { clock, advance } = fakeClock();
    const { run, started, finish } = controlledRun();
    const s = new CompileScheduler(run, { delayMs: 200, clock });
    s.request("a");
    await advance(200);
    s.request("b");
    await advance(200); // b is queued behind a
    s.request("c"); // c is waiting on its timer
    s.cancel();
    await advance(1000);
    await finish();
    expect(started).toEqual(["a"]);
    expect(s.isRunning).toBe(false);
  });

  it("survives a job that throws", async () => {
    const { clock, advance } = fakeClock();
    const started: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = new CompileScheduler(
      async (v: string) => {
        started.push(v);
        if (v === "a") throw new Error("boom");
      },
      { delayMs: 200, clock },
    );
    s.request("a");
    await advance(200);
    s.request("b");
    await advance(200);
    expect(started).toEqual(["a", "b"]);
    error.mockRestore();
  });
});

describe("CompileScheduler (throttle)", () => {
  it("runs without delay when idle, then at most once per interval", async () => {
    const { clock, advance } = fakeClock();
    const { run, started, finish } = controlledRun();
    const s = new CompileScheduler(run, {
      delayMs: 200,
      mode: "throttle",
      clock,
    });
    s.request("a");
    // Not within the request itself, see the next test.
    expect(started).toEqual([]);
    await advance(0);
    expect(started).toEqual(["a"]);
    await finish();

    await advance(50);
    s.request("b");
    s.request("c");
    await advance(100);
    expect(started).toEqual(["a"]);
    await advance(50); // 200 ms after "a" started
    expect(started).toEqual(["a", "c"]);
  });

  it("takes the latest of the requests made in one turn", async () => {
    const { clock, advance } = fakeClock();
    const { run, started } = controlledRun();
    const s = new CompileScheduler(run, {
      delayMs: 40,
      mode: "throttle",
      clock,
    });
    // Keystrokes whose messages were all waiting behind the previous job.
    s.request("a");
    s.request("b");
    s.request("c");
    await advance(0);
    expect(started).toEqual(["c"]);
  });

  it("queues behind a long job and runs the latest value when it ends", async () => {
    const { clock, advance } = fakeClock();
    const { run, started, finish } = controlledRun();
    const s = new CompileScheduler(run, {
      delayMs: 200,
      mode: "throttle",
      clock,
    });
    s.request("a");
    await flush();
    await advance(500);
    s.request("b");
    s.request("c");
    await advance(500);
    expect(started).toEqual(["a"]);
    await finish();
    await advance(0);
    expect(started).toEqual(["a", "c"]);
  });

  it("lets requests that arrive as a job ends replace the queued one", async () => {
    const { clock, advance } = fakeClock();
    const { run, started, finish } = controlledRun();
    const s = new CompileScheduler(run, {
      delayMs: 40,
      mode: "throttle",
      clock,
    });
    s.request("a");
    await flush();
    await advance(500);
    s.request("b"); // queued behind "a"
    await finish();
    // The edits typed during "a", handled only after it finished.
    s.request("c");
    s.request("d");
    expect(started).toEqual(["a"]);
    await advance(0);
    expect(started).toEqual(["a", "d"]);
  });
});

describe("CompileScheduler (waiting)", () => {
  it("reports work that is scheduled or queued behind the running job", async () => {
    const { clock, advance } = fakeClock();
    const { run, finish } = controlledRun();
    const s = new CompileScheduler(run, {
      delayMs: 40,
      mode: "throttle",
      clock,
    });
    s.request("a");
    await advance(0);
    expect(s.hasWaiting).toBe(false);

    s.request("b"); // waiting on the throttle
    expect(s.hasWaiting).toBe(true);
    await advance(40); // queued behind "a"
    expect(s.hasWaiting).toBe(true);

    await finish();
    expect(s.hasWaiting).toBe(true); // about to start, after the event loop
    await advance(0);
    expect(s.hasWaiting).toBe(false);
    expect(s.isRunning).toBe(true);

    s.request("c");
    s.cancel();
    expect(s.hasWaiting).toBe(false);
    await advance(100);
    await finish();
  });
});
