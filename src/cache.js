// CACHE-ASIDE with TTL
//
// 1. Look in Redis. Found -> return it (HIT), database never touched.
// 2. Not found -> load from the database (MISS), store in Redis with a TTL,
//    return it.
// TTL guarantees stale data eventually disappears even if invalidation is
// missed. Explicit invalidation (below) keeps data fresh right after writes.
function createCache(redis, ttlSeconds, metrics, enabled = true) {
  async function get(key) {
    try {
      const raw = await redis.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch { metrics.cacheErrors++; return null; }
  }
  async function set(key, value) {
    try { await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds); }
    catch { metrics.cacheErrors++; }
  }
  async function del(...keys) {
    try { if (keys.length) await redis.del(...keys); }
    catch { metrics.cacheErrors++; }
  }

  // Wraps a loader function: returns { value, hit }
  async function wrap(key, loader) {
    if (!enabled) { metrics.cacheMisses++; return { value: await loader(), hit: false }; }
    const cached = await get(key);
    if (cached !== null) { metrics.cacheHits++; return { value: cached, hit: true }; }
    metrics.cacheMisses++;
    const value = await loader();
    if (value !== null && value !== undefined) await set(key, value);
    return { value, hit: false };
  }
  return { get, set, del, wrap };
}
module.exports = { createCache };
