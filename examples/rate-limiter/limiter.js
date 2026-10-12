// Runs async tasks under a concurrency cap and a rate limit.
// const limiter = new Limiter({ concurrency: 2, limit: 10, interval: 1000 });
// const body = await limiter.schedule(({ signal }) => fetch(url, { signal }));
//
// concurrency  most tasks running at once (default: no cap)
// limit        most tasks started in any `interval` ms (default: no limit)
// interval     the rate limit's window in ms
// clock        { now, setTimeout, clearTimeout } (default: the real ones)
//
// Tasks start in the order they were scheduled. A task gets { signal } and may return a value or a promise.
// Aborting the signal before the task starts takes it out of the queue and rejects with signal.reason;
// once it has started, the task decides what an abort means.

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export class Limiter {
  constructor({ concurrency = Infinity, limit = Infinity, interval = 0, clock = realClock } = {}) {
    this.concurrency = concurrency;
    this.limit = limit;
    this.interval = interval;
    this.clock = clock;
    this.queue = [];
    this.active = 0;
    this.starts = [];
    this.timer = null;
    this.idle = [];
  }

  // Tasks waiting to start.
  get pending() {
    return this.queue.length;
  }

  schedule(fn, { signal } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, signal, resolve, reject });
      this.next();
    });
  }

  // Resolves once nothing is running or waiting.
  onIdle() {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  next() {
    while (this.queue.length && this.active < this.concurrency) {
      const now = this.clock.now();
      this.starts = this.starts.filter((t) => now - t < this.interval);
      if (this.starts.length >= this.limit) {
        if (!this.timer) {
          this.timer = this.clock.setTimeout(() => {
            this.timer = null;
            this.next();
          }, this.interval);
        }
        return;
      }
      const task = this.queue.pop();
      if (task.signal?.aborted) {
        task.reject(new Error("aborted"));
        continue;
      }
      this.active++;
      this.starts.push(now);
      task.fn({ signal: task.signal }).then((value) => {
        this.active--;
        task.resolve(value);
        this.next();
        if (this.active === 0 && this.queue.length === 0) {
          for (const resolve of this.idle.splice(0)) resolve();
        }
      }, task.reject);
    }
  }
}
