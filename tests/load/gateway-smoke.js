// k6 scenario for phase 44. Run only against an approved staging URL:
// k6 run -e BASE_URL=https://staging.example tests/load/gateway-smoke.js
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    gateway_smoke: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 2,
      maxVUs: 10,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

export default function () {
  const baseUrl = __ENV.BASE_URL;
  if (!baseUrl) throw new Error("BASE_URL must point to approved staging");
  const response = http.get(`${baseUrl}/health`, {
    headers: { "x-load-test": "approved-staging-only" },
  });
  check(response, { "health is 200": (res) => res.status === 200 });
  sleep(1);
}