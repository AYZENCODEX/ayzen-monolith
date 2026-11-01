import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

const DSN = process.env.SENTRY_DSN || "https://4d5a03812af5632e86c4fd6f25b316a4@o4512354569814016.ingest.us.sentry.io/4512354743746560";

export function initSentry() {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV || "production",
    integrations: [nodeProfilingIntegration()],
    sendDefaultPii: false,
    tracesSampleRate: 1.0,
    profileSessionSampleRate: 1.0,
    profileLifecycle: "trace",
  });
}

export default Sentry;
