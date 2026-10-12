import { test } from "node:test";
import assert from "node:assert/strict";
import { Limiter } from "./limiter.js";

// No test waits on real time: rate limits run on this clock, which moves only when a test advances it.
function fakeClock() {
  let now = 0;
  let seq = 0;
  let timers = [];
  return {
    now: () => now,
    setTimeout(fn, ms) {
      timers.push({ id: ++seq, at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(id) {
      timers = timers.filter((t) => t.id !== id);
    },
    // Lets what is already due settle, then moves the clock forward, firing due timers in order and letting
    // promises settle after each one.
    async advance(ms) {
      await settle();
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

// One turn of the event loop, so every promise callback that is ready has run. No timer is involved.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Records how a promise settles without awaiting it, so a stuck task fails an assertion instead of hanging.
function track(promise) {
  const result = { state: "pending", value: undefined };
  promise.then(
    (value) => Object.assign(result, { state: "fulfilled", value }),
    (error) => Object.assign(result, { state: "rejected", value: error }),
  );
  return result;
}

// A task that finishes when the test says so.
function manual() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { task: () => promise, resolve };
}

test("runs a task and resolves with its result", async () => {
  const limiter = new Limiter();
  const a = track(limiter.schedule(async () => "a"));
  await settle();
  assert.deepEqual(a, { state: "fulfilled", value: "a" });
});
test("never runs more than `concurrency` tasks at once", async () => {
  const limiter = new Limiter({ concurrency: 2 });
  const work = Array.from({ length: 5 }, () => manual());
  let running = 0;
  let peak = 0;
  const results = work.map((w) =>
    track(
      limiter.schedule(async () => {
        peak = Math.max(peak, ++running);
        try {
          return await w.task();
        } finally {
          running--;
        }
      }),
    ),
  );
  await settle();
  assert.equal(limiter.active, 2);
  assert.equal(limiter.pending, 3);
  work.forEach((w, i) => w.resolve(i));
  await settle();
  assert.equal(peak, 2);
  assert.deepEqual(results.map((r) => r.value), [0, 1, 2, 3, 4]);
  assert.equal(limiter.active, 0);
});
test("starts tasks in the order they were scheduled", async () => {
  const limiter = new Limiter({ concurrency: 1 });
  const started = [];
  for (const name of ["a", "b", "c", "d"]) track(limiter.schedule(async () => started.push(name)));
  await settle();
  assert.deepEqual(started, ["a", "b", "c", "d"]);
});
test("a failed task rejects with its error and frees its slot", async () => {
  const limiter = new Limiter({ concurrency: 1 });
  const boom = new Error("boom");
  const a = track(
    limiter.schedule(async () => {
      throw boom;
    }),
  );
  const b = track(limiter.schedule(async () => "b"));
  await settle();
  assert.deepEqual(a, { state: "rejected", value: boom });
  assert.deepEqual(b, { state: "fulfilled", value: "b" });
  assert.equal(limiter.active, 0);
});
test("a task that throws synchronously rejects like any other failure", async () => {
  const limiter = new Limiter({ concurrency: 1 });
  const boom = new Error("boom");
  const a = track(
    limiter.schedule(() => {
      throw boom;
    }),
  );
  const b = track(limiter.schedule(async () => "b"));
  await settle();
  assert.deepEqual(a, { state: "rejected", value: boom });
  assert.deepEqual(b, { state: "fulfilled", value: "b" });
});
test("a task may return a plain value", async () => {
  const limiter = new Limiter({ concurrency: 1 });
  const a = track(limiter.schedule(() => 42));
  const b = track(limiter.schedule(() => "b"));
  await settle();
  assert.deepEqual(a, { state: "fulfilled", value: 42 });
  assert.deepEqual(b, { state: "fulfilled", value: "b" });
});
test("starts at most `limit` tasks per interval", async () => {
  const clock = fakeClock();
  const limiter = new Limiter({ limit: 2, interval: 1000, clock });
  let started = 0;
  for (let i = 0; i < 5; i++) track(limiter.schedule(async () => started++));
  await settle();
  assert.equal(started, 2);
  await clock.advance(999);
  assert.equal(started, 2);
  await clock.advance(1);
  assert.equal(started, 4);
  await clock.advance(1000);
  assert.equal(started, 5);
});
test("the window slides: a start stops counting exactly `interval` ms later", async () => {
  const clock = fakeClock();
  const limiter = new Limiter({ limit: 2, interval: 1000, clock });
  const started = [];
  const go = (name) => track(limiter.schedule(async () => started.push([name, clock.now()])));
  go("a");
  await clock.advance(600);
  go("b");
  go("c");
  await clock.advance(400);
  assert.deepEqual(started, [["a", 0], ["b", 600], ["c", 1000]]);
});
test("aborting a queued task rejects it at once with the signal's reason, and it never runs", async () => {
  const limiter = new Limiter({ concurrency: 1 });
  const first = manual();
  const a = track(limiter.schedule(first.task));
  const controller = new AbortController();
  let ran = false;
  const b = track(limiter.schedule(async () => (ran = true), { signal: controller.signal }));
  controller.abort();
  await settle();
  assert.equal(b.state, "rejected");
  assert.equal(b.value, controller.signal.reason);
  assert.equal(b.value.name, "AbortError");
  first.resolve("a");
  await settle();
  assert.deepEqual(a, { state: "fulfilled", value: "a" });
  assert.equal(ran, false);
});
test("an already-aborted signal rejects with its reason without waiting for a slot", async () => {
  const limiter = new Limiter({ concurrency: 1 });
  track(limiter.schedule(manual().task));
  const reason = new Error("stop");
  let ran = false;
  const a = track(limiter.schedule(async () => (ran = true), { signal: AbortSignal.abort(reason) }));
  await settle();
  assert.deepEqual(a, { state: "rejected", value: reason });
  assert.equal(limiter.pending, 0);
  assert.equal(ran, false);
});
test("aborted tasks don't count as pending or use up the rate limit", async () => {
  const clock = fakeClock();
  const limiter = new Limiter({ limit: 1, interval: 1000, clock });
  const started = [];
  const go = (name, signal) => track(limiter.schedule(async () => started.push(name), { signal }));
  const controller = new AbortController();
  go("a");
  const b = go("b", controller.signal);
  go("c");
  await settle();
  assert.equal(limiter.pending, 2);
  controller.abort();
  await settle();
  assert.equal(b.state, "rejected");
  assert.equal(limiter.pending, 1);
  await clock.advance(1000);
  assert.deepEqual(started, ["a", "c"]);
});
test("a started task gets the signal and decides what an abort means", async () => {
  const limiter = new Limiter();
  const controller = new AbortController();
  const work = manual();
  let seen;
  const a = track(
    limiter.schedule(
      ({ signal }) => {
        seen = signal;
        return work.task();
      },
      { signal: controller.signal },
    ),
  );
  await settle();
  assert.equal(seen, controller.signal);
  controller.abort();
  await settle();
  assert.equal(a.state, "pending");
  work.resolve("done anyway");
  await settle();
  assert.deepEqual(a, { state: "fulfilled", value: "done anyway" });
});
test("onIdle resolves once nothing is running or waiting", async () => {
  const limiter = new Limiter({ concurrency: 1 });
  const already = track(limiter.onIdle());
  await settle();
  assert.equal(already.state, "fulfilled");
  const a = manual();
  const b = manual();
  track(limiter.schedule(a.task));
  track(limiter.schedule(b.task));
  const idle = track(limiter.onIdle());
  a.resolve();
  await settle();
  assert.equal(idle.state, "pending");
  b.resolve();
  await settle();
  assert.equal(idle.state, "fulfilled");
});
test("options that can't work are a RangeError", () => {
  for (const options of [{ concurrency: 0 }, { concurrency: 1.5 }, { limit: 0, interval: 1000 }, { limit: 5 }, { limit: 5, interval: -1 }]) {
    assert.throws(() => new Limiter(options), RangeError, `expected RangeError for ${JSON.stringify(options)}`);
  }
});
