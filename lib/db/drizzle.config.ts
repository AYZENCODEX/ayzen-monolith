import { defineConfig } from "drizzle-kit";
import path from "path";

if (process.env.DATABASE_URL_TARGET === "replit-test") {
  throw new Error("Full Drizzle schema push is disabled for the Replit test database. Use a reviewed test migration instead.");
}
const dbUrl = process.env.APP_DATABASE_URL;
if (!dbUrl) {
  throw new Error("Drizzle schema operations require APP_DATABASE_URL; the runtime-managed DATABASE_URL is reserved for Replit development/test use.");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  schemaFilter: ["public"],
  dbCredentials: {
    url: dbUrl,
  },
});
