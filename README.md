# DevShield: API Rate Limiting & Caching Service

A backend service (Node.js, Express, Redis) that protects an API from abusive traffic
with a **token-bucket rate limiter** and speeds it up with a **cache-aside Redis cache**.
Includes automated tests, Docker, CI, and load-test scripts.

## What it does

| Feature | How |
|---|---|
| Rate limiting | Token bucket in Redis, atomic via a Lua script. Returns `429` + `Retry-After` |
| Caching | Cache-aside with TTL. `X-Cache: HIT/MISS` header on every read |
| Cache invalidation | `PUT` deletes the affected cache keys so reads are never stale after a write |
| Resilience | Fails open if Redis is down; centralized error handler; graceful shutdown |
| Observability | `/metrics` (hit ratio, blocked requests, DB reads), `/health` |
| Delivery | Dockerfile, docker-compose (API + Redis), GitHub Actions CI with real Redis |

## 3D live visualizer

Open **http://localhost:3000/** after starting the server. It is a Three.js scene where
**every packet is a real HTTP request** to this API, so what you see is the actual limiter and cache:

- Blue cube = a GET request flying from the clients to the DevShield gate. Purple = an update (PUT).
- **Allowed:** the gate flashes green and the packet continues to the **Redis cache** (cache HIT, fast)
  or the **data source** (MISS, lingers about 50 ms) and returns to the client.
- **Blocked (429):** the gate flashes red, the packet bounces off the shield and shatters.
- **Burst x50** and **Flood** show the limiter cutting in after the first ~20 requests.
- **Update product** deletes the cache entry; the next read of that product is a MISS again.
- The token meter refills in real time using the server's own limiter settings (from `/metrics`).
- Drag to rotate, scroll to zoom. three.js is bundled in `public/vendor/`, so no internet is needed.

## Architecture (request flow)

```
client -> /api/* -> [rate limiter: Redis token bucket] -> 429 if empty
                         |
                       allowed
                         v
                 GET  -> [cache: Redis GET] -> HIT: return
                              | MISS
                              v
                        [data source] -> store in Redis (TTL) -> return
                 PUT  -> [data source] -> delete cache keys -> return
```

## How each piece works (read this before an interview)

### 1. Token bucket rate limiter (`src/rateLimiter.js`)
Every client (by IP) has a bucket that holds up to `capacity` tokens (default 20).
Each request costs one token. Tokens refill continuously at `refillPerSec` (default 10/s).
Empty bucket means `429 Too Many Requests`. This allows short bursts but caps the
sustained rate, which is why it is preferred over a simple fixed window.

**Why Lua?** "Read tokens, subtract one, write back" must be one atomic step. Without it,
two concurrent requests could both see "1 token left" and both pass. Redis executes a Lua
script atomically. The test `is atomic under concurrency` fires 40 parallel requests at a
10-token bucket and asserts exactly 10 succeed.

**Why fail open?** If Redis dies, blocking all traffic would turn a cache outage into a
full outage. We choose availability and count the event in `limiterErrors`. A deliberate,
documented trade-off.

### 2. Cache-aside (`src/cache.js`)
Look in Redis first. Hit: return it and never touch the data source. Miss: load, store
with a TTL, return. The TTL is a safety net so stale data always expires.

### 3. Invalidation (`PUT /api/products/:id`)
After updating the data source, the product's key and the list key are deleted so the next
read repopulates with fresh data. Tests prove a read after a write returns the new value.

### 4. Dependency injection (`createApp({ redis, config })`)
`app.js` receives Redis and config as arguments instead of creating them. Tests pass in
their own small limits (so they run in seconds) and even a broken Redis (to test fail-open).

### 5. The simulated data source (`src/db.js`)
**Be honest about this on your resume and in interviews.** The data source is an in-memory
store with an artificial 50 ms delay standing in for a database query. That makes cache
benefits measurable without needing a database. Section "Level up" below shows how to swap
in real PostgreSQL. Until you do, describe it as a "simulated 50 ms data source".

## Run it

**Option A: Docker (recommended)**
```bash
docker compose up --build
curl -i localhost:3000/api/products/1     # X-Cache: MISS
curl -i localhost:3000/api/products/1     # X-Cache: HIT
```

**Option B: local**
```bash
# needs Redis running on localhost:6379
npm install
npm start
```

**Watch the rate limiter work:**
```bash
for i in $(seq 1 30); do curl -s -o /dev/null -w "%{http_code} " localhost:3000/api/products/1; done
# first ~20 print 200, the rest print 429
```

## Test it
```bash
npm test        # 17 tests + coverage report (needs Redis on localhost:6379)
```
Tests cover: burst/limit behavior, headers, Retry-After, token refill over time, atomicity
under concurrency, fail-open, cache hit/miss, TTL expiry, 404 not cached, invalidation on
write, input validation.

## Get YOUR resume numbers (do this yourself, then use only what you measure)

Use a high rate limit so the limiter doesn't block your measurement:

```bash
# 1) BEFORE: caching off
CACHE_ENABLED=false RL_CAPACITY=1000000 RL_REFILL_PER_SEC=1000000 npm start
node loadtest/bench.js http://localhost:3000        # in a second terminal; write down results
# stop the server, then

# 2) AFTER: caching on
RL_CAPACITY=1000000 RL_REFILL_PER_SEC=1000000 npm start
node loadtest/bench.js http://localhost:3000        # write down results

# 3) Rate limiter: default limits
npm start
node loadtest/bench.js http://localhost:3000        # note the 429 count vs total
```
`bench.js` prints requests/sec, p50/p99 latency, and status counts. `/metrics` gives the cache
hit ratio and how many DB reads actually happened. (Optional: `loadtest/k6.js` is the same
idea for k6.)

Sample result from the build machine, to show what to expect (YOURS WILL DIFFER, use yours):
no cache about 800 req/s at p50 58 ms. With cache about 4,500 req/s at p50 8 ms.
Default limits blocked about 99.8% of a flood from one client.

## Turn results into resume bullets (replace with YOUR numbers)

- Raised throughput from **[A]** to **[B] req/s** and cut p50 latency from **[C] ms to [D] ms**
  by adding a Redis cache-aside layer with TTL and write-invalidation (autocannon, 50 connections, 15 s).
- Blocked **[X]%** of requests from a single flooding client with a Redis token-bucket
  limiter (atomic Lua script), returning 429 with Retry-After headers.
- Verified behavior with **17** Jest/Supertest tests (**[coverage]%** coverage), including a
  40-request concurrency test; automated in GitHub Actions with a Redis service container.
- Containerized with Docker and docker-compose (API + Redis) for one-command setup.

## Deploy (to earn the "live link")
1. Push to GitHub (CI runs automatically; add the green badge to your README).
2. On Render: create a **Redis** instance (free tier) and a **Web Service** from your repo
   (Docker runtime). Set `REDIS_URL` to the Redis internal URL.
3. Put the live URL on your resume.

## Level up (each adds real resume value)
1. **Real database:** swap `src/db.js` for PostgreSQL (`pg`) with the same three functions.
   Then you can drop "simulated" from your resume.
2. **Per-API-key limits:** limit by `x-api-key` header, with tiers (free 10/s, pro 100/s).
3. **Cache stampede protection:** a short Redis lock so 1,000 simultaneous misses trigger one DB read.
4. **Prometheus metrics endpoint** and a Grafana dashboard screenshot.

## Interview questions you should be able to answer
- Why token bucket instead of fixed window? (Fixed windows allow 2x bursts at window edges.)
- Why a Lua script? (Atomicity; show the race without it.)
- Why TTL if you invalidate? (Safety net for missed invalidations.)
- What happens if Redis is down? (Fail open; trade-off explained.)
- What's a cache stampede and how would you prevent it?
- How would you scale this across multiple API servers? (State is in Redis, so servers are stateless.)
