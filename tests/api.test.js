const Redis = require('ioredis');
const request = require('supertest');
const { createApp } = require('../src/app');

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

// Fast, small limits so tests run quickly.
const baseConfig = {
  rateLimit: { capacity: 5, refillPerSec: 1 },
  cache: { ttlSeconds: 30 },
  dbLatencyMs: 5,
};
const make = (over = {}) => createApp({ redis, config: { ...baseConfig, ...over } });

beforeEach(async () => { await redis.flushdb(); });
afterAll(async () => { await redis.quit(); });

describe('health and metrics', () => {
  test('/health returns ok and is not rate limited', async () => {
    const app = make({ rateLimit: { capacity: 1, refillPerSec: 0.001 } });
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    }
  });
});

describe('visualizer UI', () => {
  test('GET / serves the 3D visualizer page', async () => {
    const res = await request(make()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('DevShield');
  });
  test('/metrics exposes config for the UI', async () => {
    const res = await request(make()).get('/metrics');
    expect(res.body.config.capacity).toBe(5);
  });
});

describe('rate limiting (token bucket)', () => {
  test('allows requests up to capacity then returns 429', async () => {
    const app = make();
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await request(app).get('/api/products/1')).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  test('sets X-RateLimit headers and decrements remaining', async () => {
    const app = make();
    const a = await request(app).get('/api/products/1');
    const b = await request(app).get('/api/products/1');
    expect(a.headers['x-ratelimit-limit']).toBe('5');
    expect(Number(a.headers['x-ratelimit-remaining'])).toBe(4);
    expect(Number(b.headers['x-ratelimit-remaining'])).toBe(3);
  });

  test('429 response includes Retry-After', async () => {
    const app = make({ rateLimit: { capacity: 1, refillPerSec: 1 } });
    await request(app).get('/api/products/1');
    const res = await request(app).get('/api/products/1');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
  });

  test('tokens refill over time', async () => {
    const app = make({ rateLimit: { capacity: 1, refillPerSec: 10 } });
    expect((await request(app).get('/api/products/1')).status).toBe(200);
    expect((await request(app).get('/api/products/1')).status).toBe(429);
    await new Promise((r) => setTimeout(r, 250));
    expect((await request(app).get('/api/products/1')).status).toBe(200);
  });

  test('is atomic under concurrency: never allows more than capacity', async () => {
    const app = make({ rateLimit: { capacity: 10, refillPerSec: 0.001 } });
    const results = await Promise.all(
      Array.from({ length: 40 }, () => request(app).get('/api/products/1'))
    );
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(10);
  });

  test('fails open when Redis errors', async () => {
    const broken = { defineCommand() {}, tokenBucket: async () => { throw new Error('down'); },
      get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); }, del: async () => {} };
    const app = createApp({ redis: broken, config: baseConfig });
    const res = await request(app).get('/api/products/1');
    expect(res.status).toBe(200);
  });
});

describe('caching (cache-aside)', () => {
  test('first read is a MISS, second is a HIT', async () => {
    const app = make({ rateLimit: { capacity: 100, refillPerSec: 100 } });
    const a = await request(app).get('/api/products/2');
    const b = await request(app).get('/api/products/2');
    expect(a.headers['x-cache']).toBe('MISS');
    expect(b.headers['x-cache']).toBe('HIT');
    expect(b.body).toEqual(a.body);
  });

  test('cache hits do not touch the database', async () => {
    const app = make({ rateLimit: { capacity: 100, refillPerSec: 100 } });
    for (let i = 0; i < 10; i++) await request(app).get('/api/products/3');
    const m = (await request(app).get('/metrics')).body;
    expect(m.dbReads).toBe(1);
    expect(m.cacheHits).toBe(9);
    expect(m.cacheMisses).toBe(1);
    expect(m.cacheHitRatio).toBe(0.9);
  });

  test('entries expire after the TTL', async () => {
    const app = make({ rateLimit: { capacity: 100, refillPerSec: 100 }, cache: { ttlSeconds: 1 } });
    await request(app).get('/api/products/4');
    await new Promise((r) => setTimeout(r, 1200));
    const res = await request(app).get('/api/products/4');
    expect(res.headers['x-cache']).toBe('MISS');
  });

  test('missing product returns 404 and is not cached', async () => {
    const app = make({ rateLimit: { capacity: 100, refillPerSec: 100 } });
    const a = await request(app).get('/api/products/99999');
    const b = await request(app).get('/api/products/99999');
    expect(a.status).toBe(404);
    expect(b.headers['x-cache']).toBe('MISS');
  });

  test('list endpoint is cached too', async () => {
    const app = make({ rateLimit: { capacity: 100, refillPerSec: 100 } });
    const a = await request(app).get('/api/products');
    const b = await request(app).get('/api/products');
    expect(a.headers['x-cache']).toBe('MISS');
    expect(b.headers['x-cache']).toBe('HIT');
    expect(a.body).toHaveLength(20);
  });
});

describe('cache invalidation on write', () => {
  test('PUT invalidates the cached item so next read is fresh', async () => {
    const app = make({ rateLimit: { capacity: 100, refillPerSec: 100 } });
    await request(app).get('/api/products/5');
    const put = await request(app).put('/api/products/5').send({ price: 999 });
    expect(put.status).toBe(200);
    const after = await request(app).get('/api/products/5');
    expect(after.headers['x-cache']).toBe('MISS');
    expect(after.body.price).toBe(999);
  });

  test('PUT also invalidates the list cache', async () => {
    const app = make({ rateLimit: { capacity: 100, refillPerSec: 100 } });
    await request(app).get('/api/products');
    await request(app).put('/api/products/1').send({ name: 'Renamed' });
    const list = await request(app).get('/api/products');
    expect(list.headers['x-cache']).toBe('MISS');
    expect(list.body.find((p) => p.id === '1').name).toBe('Renamed');
  });
});

describe('validation and errors', () => {
  const app = () => make({ rateLimit: { capacity: 100, refillPerSec: 100 } });

  test('rejects non-string name', async () => {
    const res = await request(app()).put('/api/products/1').send({ name: 123 });
    expect(res.status).toBe(400);
  });
  test('rejects negative price', async () => {
    const res = await request(app()).put('/api/products/1').send({ price: -5 });
    expect(res.status).toBe(400);
  });
  test('PUT on unknown product returns 404', async () => {
    const res = await request(app()).put('/api/products/99999').send({ price: 5 });
    expect(res.status).toBe(404);
  });
});
