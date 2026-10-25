const Redis = require('ioredis');
const config = require('./config');
const { createApp } = require('./app');

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', (e) => console.error('Redis error:', e.message));

const app = createApp({ redis, config });
const server = app.listen(config.port, () => console.log(`DevShield listening on :${config.port}`));

// Graceful shutdown: finish in-flight requests, then close Redis.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => redis.quit().then(() => process.exit(0))));
}
