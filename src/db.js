// A deliberately slow in-memory data source. It plays the role of a real
// database (PostgreSQL/MongoDB). Every call waits `latencyMs` so that cache
// hits vs misses show a clear, measurable difference.
// To make it real: replace these functions with SQL/Mongo queries and keep
// the same signatures. Nothing else in the project needs to change.
function createDb(latencyMs) {
  const products = new Map();
  for (let i = 1; i <= 100; i++) {
    products.set(String(i), { id: String(i), name: `Product ${i}`, price: 10 + i, updatedAt: Date.now() });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stats = { reads: 0, writes: 0 };

  return {
    stats,
    async getProduct(id) {
      stats.reads++;
      await sleep(latencyMs);
      return products.get(String(id)) || null;
    },
    async listProducts() {
      stats.reads++;
      await sleep(latencyMs);
      return Array.from(products.values()).slice(0, 20);
    },
    async updateProduct(id, patch) {
      stats.writes++;
      await sleep(latencyMs);
      const cur = products.get(String(id));
      if (!cur) return null;
      const next = { ...cur, ...patch, id: cur.id, updatedAt: Date.now() };
      products.set(String(id), next);
      return next;
    },
  };
}
module.exports = { createDb };
