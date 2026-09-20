// Dedicated Render staging entrypoint; no workers or migrations are started.
process.argv[2] = "typescript";
await import("./check-runner-env.mjs");
if (process.exitCode) process.exit(process.exitCode);
if (
  !process.env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_") ||
  (process.env.INTERNAL_API_KEY?.length ?? 0) < 32 ||
  !process.env.CORS_ORIGINS ||
  process.env.CORS_ORIGINS.includes("*")
) {
  console.error("staging_api_configuration_rejected");
  process.exit(1);
}
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set("connection_limit", "3");
url.searchParams.set("pool_timeout", "10");
process.env.DATABASE_URL = url.toString();
await import("../apps/api/dist/apps/api/src/server.js");
