function createRateLimiter({ windowMs = 60_000, max = 120 } = {}) {
  const buckets = new Map();

  function cleanup(now) {
    for (const [key, bucket] of buckets.entries()) {
      if (now - bucket.start >= windowMs) {
        buckets.delete(key);
      }
    }
  }

  function allow(key) {
    const now = Date.now();
    cleanup(now);
    const bucket = buckets.get(key) || { start: now, count: 0 };
    if (now - bucket.start >= windowMs) {
      bucket.start = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    return bucket.count <= max;
  }

  return { allow };
}

module.exports = {
  createRateLimiter,
};
