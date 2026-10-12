import { test } from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "./lru-cache.js";

// Every onEvict call, in order.
function recorder() {
  const calls = [];
  return { calls, onEvict: (key, value, reason) => calls.push([key, value, reason]) };
}

test("stores values; missing keys are undefined", () => {
  const cache = new LRUCache({ max: 3 });
  assert.equal(cache.set("a", 1), cache);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), undefined);
});
test("size counts entries", () => {
  const cache = new LRUCache({ max: 5 });
  cache.set("a", 1).set("b", 2).set("c", 3);
  assert.equal(cache.size, 3);
  assert.equal(cache.delete("b"), true);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("b"), undefined);
});
test("evicts the least recently used entry when full", () => {
  const { calls, onEvict } = recorder();
  const cache = new LRUCache({ max: 2, onEvict });
  cache.set("a", 1).set("b", 2).set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.deepEqual(cache.keys(), ["c", "b"]);
  assert.deepEqual(calls, [["a", 1, "evict"]]);
});
test("get counts as a use", () => {
  const cache = new LRUCache({ max: 2 });
  cache.set("a", 1).set("b", 2);
  cache.get("a");
  cache.set("c", 3);
  assert.deepEqual(cache.keys(), ["c", "a"]);
  assert.equal(cache.get("b"), undefined);
});
test("peek doesn't count as a use", () => {
  const cache = new LRUCache({ max: 2 });
  cache.set("a", 1).set("b", 2);
  assert.equal(cache.peek("a"), 1);
  assert.equal(cache.peek("z"), undefined);
  cache.set("c", 3);
  assert.deepEqual(cache.keys(), ["c", "b"]);
});
test("has is true for a stored undefined and doesn't count as a use", () => {
  const cache = new LRUCache({ max: 2 });
  cache.set("a", undefined).set("b", 2);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("z"), false);
  cache.set("c", 3);
  assert.equal(cache.has("a"), false);
  assert.deepEqual(cache.keys(), ["c", "b"]);
});
test("setting an existing key makes it most recent and evicts nothing", () => {
  const { calls, onEvict } = recorder();
  const cache = new LRUCache({ max: 2, onEvict });
  cache.set("a", 1).set("b", 2).set("a", 10);
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.keys(), ["a", "b"]);
  assert.deepEqual(calls, [["a", 1, "set"]]);
  cache.set("c", 3);
  assert.deepEqual(cache.keys(), ["c", "a"]);
  assert.deepEqual(calls, [["a", 1, "set"], ["b", 2, "evict"]]);
});
test("onEvict hears about deletes and replaced values, not no-ops", () => {
  const { calls, onEvict } = recorder();
  const cache = new LRUCache({ max: 2, onEvict });
  cache.set("a", 1).set("a", 1); // same value: nothing left the cache
  cache.set("a", 2);
  assert.equal(cache.delete("a"), true);
  assert.equal(cache.delete("a"), false);
  assert.equal(cache.delete("nope"), false);
  assert.deepEqual(calls, [["a", 1, "set"], ["a", 2, "delete"]]);
});
test("an entry expires exactly ttl ms after it was set", () => {
  let t = 0;
  const cache = new LRUCache({ max: 10, ttl: 1000, now: () => t });
  cache.set("a", 1);
  t = 999;
  assert.equal(cache.get("a"), 1);
  t = 1000;
  assert.equal(cache.get("a"), undefined);
});
test("expired entries leave size and keys, and onEvict hears once", () => {
  let t = 0;
  const { calls, onEvict } = recorder();
  const cache = new LRUCache({ max: 10, ttl: 1000, now: () => t, onEvict });
  cache.set("a", 1);
  t = 500;
  cache.set("b", 2);
  t = 1000;
  assert.equal(cache.size, 1);
  assert.deepEqual(cache.keys(), ["b"]);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.peek("a"), undefined);
  assert.deepEqual(calls, [["a", 1, "expire"]]);
});
test("a per-entry ttl overrides the default, and 0 means never", () => {
  let t = 0;
  const cache = new LRUCache({ max: 10, ttl: 1000, now: () => t });
  cache.set("short", 1).set("long", 2, { ttl: 5000 }).set("forever", 3, { ttl: 0 });
  t = 2000;
  assert.equal(cache.get("short"), undefined);
  assert.equal(cache.get("long"), 2);
  t = 6000;
  assert.equal(cache.get("long"), undefined);
  t = 1e12;
  assert.equal(cache.get("forever"), 3);
});
test("setting a key again restarts its ttl", () => {
  let t = 0;
  const cache = new LRUCache({ max: 10, ttl: 1000, now: () => t });
  cache.set("a", 1);
  t = 800;
  cache.set("a", 2);
  t = 1500;
  assert.equal(cache.get("a"), 2);
  t = 2000;
  assert.equal(cache.get("a"), undefined);
});
test("a full cache drops expired entries before evicting a live one", () => {
  let t = 0;
  const { calls, onEvict } = recorder();
  const cache = new LRUCache({ max: 2, now: () => t, onEvict });
  cache.set("a", 1, { ttl: 100 }).set("b", 2);
  t = 50;
  cache.get("a"); // a is now the most recently used...
  t = 100; // ...but it has expired
  cache.set("c", 3);
  assert.deepEqual(cache.keys(), ["c", "b"]);
  assert.deepEqual(calls, [["a", 1, "expire"]]);
});
test("max must be a positive integer and ttl can't be negative", () => {
  for (const options of [{}, { max: 0 }, { max: -1 }, { max: 1.5 }, { max: 1, ttl: -1 }]) {
    assert.throws(() => new LRUCache(options), RangeError, `expected RangeError for ${JSON.stringify(options)}`);
  }
});
