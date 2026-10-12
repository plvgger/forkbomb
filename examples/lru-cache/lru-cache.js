// A least-recently-used cache with optional expiry.
// const cache = new LRUCache({ max: 100, ttl: 60_000 });
// cache.set("a", 1).get("a") === 1
//
// max      most entries kept; setting one more evicts the least recently used
// ttl      default time to live in ms; 0 means entries never expire
// now      the clock, () => ms (Date.now by default)
// onEvict  (key, value, reason) when an entry leaves the cache, reason one of
//          "evict" (pushed out by max), "expire", "delete", "set" (value replaced)

export class LRUCache {
  #map = new Map();

  constructor({ max, ttl = 0, now = Date.now, onEvict } = {}) {
    this.max = max;
    this.ttl = ttl;
    this.now = now;
    this.onEvict = onEvict;
  }

  get size() {
    return this.#map.size;
  }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (entry.expires && entry.expires < this.now()) {
      this.#map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  // Like get, but doesn't count as a use.
  peek(key) {
    return this.get(key);
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, options = {}) {
    const ttl = options.ttl || this.ttl;
    if (this.#map.size >= this.max) {
      const oldest = this.#map.keys().next().value;
      const entry = this.#map.get(oldest);
      this.#map.delete(oldest);
      this.onEvict?.(oldest, entry.value, "evict");
    }
    this.#map.set(key, { value, expires: ttl ? this.now() + ttl : 0 });
    return this;
  }

  delete(key) {
    const entry = this.#map.get(key);
    this.onEvict?.(key, entry?.value, "delete");
    return this.#map.delete(key);
  }

  // Keys from most to least recently used.
  keys() {
    return [...this.#map.keys()].reverse();
  }
}
