import { createServiceServer } from "@ayzen/service-runtime";

const service = process.env.AYZEN_SERVICE_NAME ?? "service-template";
createServiceServer({
  service,
  displayName: process.env.AYZEN_SERVICE_DISPLAY_NAME ?? service,
  port: Number(process.env.PORT ?? 8080),
  routePrefixes: (process.env.AYZEN_ROUTE_PREFIXES ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  dependencies: { configuration: true },
}).start();