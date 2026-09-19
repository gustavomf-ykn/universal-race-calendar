import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function validateStagingEnvironment(env, expectedRef) {
  const fail = () => {
    throw new Error("staging_configuration_rejected");
  };
  if (
    !/^[a-z]{20}$/.test(expectedRef ?? "") ||
    env.STAGING_PROJECT_REF !== expectedRef ||
    env.STAGING_PROJECT_NAME !== "race-platform-staging"
  )
    fail();
  if (env.SUPABASE_URL !== `https://${expectedRef}.supabase.co`) fail();
  for (const name of ["DATABASE_URL", "DIRECT_URL", "WORKER_DATABASE_URL"]) {
    let url;
    try {
      url = new URL(env[name]);
    } catch {
      fail();
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.password || url.pathname !== "/postgres") fail();
    if (!["require", "verify-full"].includes(url.searchParams.get("sslmode"))) fail();
    const direct = url.hostname === `db.${expectedRef}.supabase.co` && url.username === "postgres";
    const session = url.hostname.endsWith(".pooler.supabase.com") && url.username === `postgres.${expectedRef}`;
    if (!(direct || session) || (url.port && url.port !== "5432")) fail();
    if (name === "WORKER_DATABASE_URL" && url.searchParams.has("schema")) fail();
  }
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !env.SUPABASE_PUBLISHABLE_KEY || (env.INTERNAL_API_KEY?.length ?? 0) < 32) fail();
  if (key.startsWith("eyJ")) {
    try {
      const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url"));
      if (claims.ref !== expectedRef || claims.role !== "service_role") fail();
    } catch {
      fail();
    }
  } else if (!key.startsWith("sb_secret_")) fail();
  return { projectName: env.STAGING_PROJECT_NAME, projectRef: expectedRef, configuration: "valid" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2] ?? "check",
      ref = process.argv[3] ?? process.env.STAGING_PROJECT_REF;
    const summary = validateStagingEnvironment(process.env, ref);
    if (mode === "migrate") {
      const run = spawnSync(
        process.execPath,
        [
          "packages/database/node_modules/prisma/build/index.js",
          "migrate",
          "deploy",
          "--schema",
          "packages/database/prisma/schema.prisma",
        ],
        { encoding: "utf8", env: process.env },
      );
      if (run.status !== 0) throw new Error("migration_failed");
    } else if (mode !== "check") throw new Error("invalid_mode");
    console.log(JSON.stringify({ ...summary, operation: mode, status: "passed" }));
  } catch {
    console.error(
      JSON.stringify({
        status: "failed",
        error: "staging_preflight_or_migration_failed",
        details:
          "Check project identity, required secrets, SSL/session connection and database access. No secret values were logged.",
      }),
    );
    process.exitCode = 1;
  }
}
