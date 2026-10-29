const baseUrl = (process.env.SMOKE_BASE_URL ?? process.argv.find((arg) => arg.startsWith("--url="))?.slice("--url=".length))?.replace(/\/+$/, "");
if (!baseUrl) {
  console.error("SMOKE_BASE_URL or --url is required");
  process.exit(1);
}
const paths = (process.env.SMOKE_PATHS ?? "/health,/ready").split(",").map((value) => value.trim()).filter(Boolean);
const attempts = Number(process.env.SMOKE_ATTEMPTS ?? 3);
const delayMs = Number(process.env.SMOKE_RETRY_DELAY_MS ?? 1000);

for (const pathname of paths) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${pathname}`, { redirect: "error" });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      console.log(JSON.stringify({ ok: true, path: pathname, status: response.status, attempt }));
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (lastError) {
    console.error(JSON.stringify({ ok: false, path: pathname, error: lastError.message }));
    process.exit(1);
  }
}