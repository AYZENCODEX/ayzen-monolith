import { createEventEnvelope } from "../packages/events/src/index.mjs";

const status = process.argv.find((arg) => arg.startsWith("--status="))?.slice("--status=".length) ?? "succeeded";
const service = process.argv.find((arg) => arg.startsWith("--service="))?.slice("--service=".length) ?? "unknown";
const eventType = status === "started" ? "deployment.started" : status === "failed" ? "deployment.failed" : "deployment.succeeded";
const event = createEventEnvelope({
  eventType,
  payload: {
    service,
    environment: process.env.DEPLOYMENT_ENVIRONMENT ?? "staging",
    releaseId: process.env.RELEASE_ID ?? "local",
    commit: process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? "local",
    imageDigest: process.env.IMAGE_DIGEST,
  },
  traceId: process.env.TRACE_ID,
  correlationId: process.env.CORRELATION_ID,
  metadata: { source: "ci-cd", producer: "release-workflow" },
});
console.log(JSON.stringify(event, null, 2));