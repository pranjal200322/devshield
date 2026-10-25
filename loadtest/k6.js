// k6 load test. Run it TWICE to get your before/after numbers (see README).
// Usage: k6 run -e BASE=http://localhost:3000 loadtest/k6.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    read_heavy: {
      executor: 'constant-arrival-rate',
      rate: 200, timeUnit: '1s', duration: '30s',
      preAllocatedVUs: 50, maxVUs: 200,
    },
  },
  thresholds: { http_req_duration: ['p(95)<500'] },
};

const BASE = __ENV.BASE || 'http://localhost:3000';

export default function () {
  // 80% of traffic hits a few "hot" products, like real traffic usually does.
  const id = Math.random() < 0.8 ? Math.ceil(Math.random() * 5) : Math.ceil(Math.random() * 100);
  const res = http.get(`${BASE}/api/products/${id}`);
  check(res, { 'ok or limited': (r) => r.status === 200 || r.status === 429 });
}
