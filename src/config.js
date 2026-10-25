// All tunable values live here, read from environment variables, so the same
// code runs locally, in Docker, and in the cloud without edits.
module.exports = {
  port: Number(process.env.PORT || 3000),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  // Token bucket: each client can burst up to `capacity` requests,
  // and earns `refillPerSec` tokens back every second.
  rateLimit: {
    capacity: Number(process.env.RL_CAPACITY || 50),
    refillPerSec: Number(process.env.RL_REFILL_PER_SEC || 50),
  },

  cache: {
    // Set CACHE_ENABLED=false to get your "before caching" baseline.
    enabled: process.env.CACHE_ENABLED !== 'false',
    ttlSeconds: Number(process.env.CACHE_TTL || 30),
  },

  // Simulated latency of the "slow" data source (ms). This stands in for a
  // real database query so the effect of caching is measurable.
  dbLatencyMs: Number(process.env.DB_LATENCY_MS || 50),
};
