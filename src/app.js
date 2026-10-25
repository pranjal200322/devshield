const path = require('path');
const express = require('express');
const { createRateLimiter } = require('./rateLimiter');
const { createCache } = require('./cache');
const { createDb } = require('./db');

// createApp takes its dependencies as arguments (dependency injection),
// which makes it easy to test: tests pass in a test Redis and fast DB.
function createApp({ redis, config }) {
  const app = express();
  app.use(express.json());

  // Serve the 3D visualizer (public/index.html). Static files are NOT rate
  // limited; only /api is.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const metrics = {
    allowed: 0, blocked: 0, limiterErrors: 0,
    cacheHits: 0, cacheMisses: 0, cacheErrors: 0,
  };
  const db = createDb(config.dbLatencyMs);
  const cache = createCache(redis, config.cache.ttlSeconds, metrics, config.cache.enabled !== false);

  // Health and metrics are NOT rate limited so monitors can always reach them.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/metrics', (_req, res) => {
    const lookups = metrics.cacheHits + metrics.cacheMisses;
    res.json({
      ...metrics,
      dbReads: db.stats.reads,
      // Lets the UI draw an accurate token bucket.
      config: {
        capacity: config.rateLimit.capacity,
        refillPerSec: config.rateLimit.refillPerSec,
        cacheTtlSeconds: config.cache.ttlSeconds,
      },
      cacheHitRatio: lookups ? +(metrics.cacheHits / lookups).toFixed(4) : 0,
    });
  });

  // Everything under /api is rate limited.
  app.use('/api', createRateLimiter(redis, config.rateLimit, metrics));

  app.get('/api/products/:id', async (req, res, next) => {
    try {
      const { value, hit } = await cache.wrap(`product:${req.params.id}`, () => db.getProduct(req.params.id));
      res.set('X-Cache', hit ? 'HIT' : 'MISS');
      if (!value) return res.status(404).json({ error: 'Not found' });
      res.json(value);
    } catch (e) { next(e); }
  });

  app.get('/api/products', async (_req, res, next) => {
    try {
      const { value, hit } = await cache.wrap('products:list', () => db.listProducts());
      res.set('X-Cache', hit ? 'HIT' : 'MISS');
      res.json(value);
    } catch (e) { next(e); }
  });

  // Writes go to the database, then INVALIDATE related cache keys so the
  // next read fetches fresh data instead of a stale copy.
  app.put('/api/products/:id', async (req, res, next) => {
    try {
      const { name, price } = req.body || {};
      if (name !== undefined && typeof name !== 'string') return res.status(400).json({ error: 'name must be a string' });
      if (price !== undefined && (typeof price !== 'number' || price < 0)) return res.status(400).json({ error: 'price must be a non-negative number' });
      const updated = await db.updateProduct(req.params.id, { ...(name !== undefined && { name }), ...(price !== undefined && { price }) });
      if (!updated) return res.status(404).json({ error: 'Not found' });
      await cache.del(`product:${req.params.id}`, 'products:list');
      res.json(updated);
    } catch (e) { next(e); }
  });

  // Centralized error handler: one place that turns failures into clean 500s.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}
module.exports = { createApp };
