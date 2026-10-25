// TOKEN BUCKET RATE LIMITER (backed by Redis)
//
// Idea: every client has a bucket holding up to `capacity` tokens.
// Each request costs 1 token. Tokens refill continuously at `refillPerSec`.
// Empty bucket -> HTTP 429 (Too Many Requests).
//
// Why a Lua script? Reading the bucket, updating it and writing it back must
// happen as ONE atomic step. Otherwise two concurrent requests could both read
// "1 token left" and both be allowed. Redis runs a Lua script atomically.
const LUA = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refill    = tonumber(ARGV[2])
local now       = tonumber(ARGV[3])   -- milliseconds

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end

-- add tokens earned since last request, never exceeding capacity
local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- key expires once the bucket would be full again (keeps Redis tidy)
redis.call('PEXPIRE', key, math.ceil((capacity / refill) * 1000) + 1000)

return { allowed, math.floor(tokens) }
`;

function createRateLimiter(redis, { capacity, refillPerSec }, metrics) {
  redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: LUA });

  return async function rateLimiter(req, res, next) {
    const clientId = req.ip; // swap for an API key header in production
    try {
      const [allowed, remaining] = await redis.tokenBucket(
        `rl:${clientId}`, capacity, refillPerSec, Date.now()
      );
      res.set('X-RateLimit-Limit', String(capacity));
      res.set('X-RateLimit-Remaining', String(remaining));

      if (!allowed) {
        metrics.blocked++;
        res.set('Retry-After', String(Math.ceil(1 / refillPerSec)));
        return res.status(429).json({ error: 'Too Many Requests' });
      }
      metrics.allowed++;
      return next();
    } catch (err) {
      // FAIL OPEN: if Redis is down we let traffic through rather than take
      // the whole API down with it. A deliberate availability trade-off.
      metrics.limiterErrors++;
      return next();
    }
  };
}
module.exports = { createRateLimiter };
