// Node-based benchmark (no k6 install needed). Hits a few hot products hard
// and prints throughput, latency percentiles and the server's own metrics.
//   node loadtest/bench.js http://localhost:3000
const autocannon = require('autocannon');
const base = process.argv[2] || 'http://localhost:3000';

(async () => {
  const result = await autocannon({
    url: base,
    connections: 50,
    duration: 15,
    requests: [1, 2, 3, 4, 5].map((id) => ({ method: 'GET', path: `/api/products/${id}` })),
  });
  const codes = {
    '2xx': result['2xx'], '4xx/5xx (incl. 429 blocked)': result.non2xx,
  };
  console.log('\n=== RESULTS ===');
  console.log('requests total   :', result.requests.total);
  console.log('throughput (avg) :', result.requests.average, 'req/s');
  console.log('latency avg      :', result.latency.average, 'ms');
  console.log('latency p50      :', result.latency.p50, 'ms');
  console.log('latency p97.5    :', result.latency.p97_5, 'ms');
  console.log('latency p99      :', result.latency.p99, 'ms');
  console.log('status counts    :', codes);
  const m = await (await fetch(`${base}/metrics`)).json();
  console.log('server metrics   :', m);
})();
