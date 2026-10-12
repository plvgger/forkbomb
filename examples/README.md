# Examples

Small repos with real bugs to race Forkbomb on. Each one is an ES module package for Node 22 or newer, with no dependencies, tested with `node --test`. The tests are the spec. Each example has several bugs that interact: in `lru-cache`, `peek` is built on `get`, so making `get` count as a use breaks `peek`.

| Example | What's broken | Baseline | Run it |
|---|---|--:|---|
| [calc](calc/) | Evaluates left to right: no precedence, and `^` isn't right-associative. No unary minus, no `.5`, no tabs or newlines. Division by zero and malformed input don't throw the right errors. | 4/14 | `forkbomb run ./examples/calc --task "fix the failing tests" --test "node --test" --forks 4` |
| [durations](durations/) | `500ms` parses as minutes and `2.5h` as `5h`. Junk is skipped, and a leading minus covers only the first part. ISO `P1M` reads as a minute. `format` prints `60s`, `-1h -30m` and empty strings, and `formatISO` prints `P1DT`. Errors don't say where. | 4/16 | `forkbomb run ./examples/durations --task "fix the failing tests" --test "node --test" --forks 4` |
| [lru-cache](lru-cache/) | `get` doesn't count as a use, and `peek` and `has` are built on it. Setting a key that's already there evicts the oldest entry when the cache is full. Entries expire 1 ms late, `ttl: 0` falls back to the default, and expired entries still count. `onEvict` never hears about expiries or replaced values, and does hear about deleting a missing key. Bad options are accepted. | 5/14 | `forkbomb run ./examples/lru-cache --task "fix the failing tests" --test "node --test" --forks 4` |
| [rate-limiter](rate-limiter/) | Queued tasks start last in, first out. A task that rejects or throws never frees its slot. One that returns a plain value makes the limiter throw a `TypeError`: the task's promise rejects if it starts at once, and never settles if it waited in the queue. A task held by the rate limit waits a full interval instead of until the oldest start leaves the window. An abort is noticed only when the task reaches the front, and rejects with the wrong error. Bad options are accepted. | 5/14 | `forkbomb run ./examples/rate-limiter --task "fix the failing tests" --test "node --test" --forks 4` |

Run the commands from the repo root, and add `--ui` to watch the process tree. Baseline is the tests passing out of the total before any fork starts, counted the way Forkbomb counts its baseline. [`test/examples.test.ts`](../test/examples.test.ts) runs every example's suite and fails when this table is out of date.

No test waits on real time. The LRU cache takes a clock function and the rate limiter a clock object, and their tests drive fake ones, so a suite gives the same result on every judge run.

To add an example, give it a folder and a row in the table. Name its tests `*.test.js` and put any fixture they read under `test/`. `test/examples.test.ts` also checks that the judge drops a fork's edits to the tests, `package.json` and every other file that isn't JavaScript code or Markdown.
