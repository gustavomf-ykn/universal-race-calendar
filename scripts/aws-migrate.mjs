import { spawnSync } from "node:child_process";
import { assertAwsStaging } from "@race-calendar/utils";
try {
  if (process.env.HOSTING_TARGET !== "aws") throw Error();
  assertAwsStaging(process.env, ["DATABASE_URL", "DIRECT_URL"]);
  const run = spawnSync(
    process.execPath,
    [
      "packages/database/node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
      "--schema",
      "packages/database/prisma/schema.prisma",
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (run.status !== 0) throw Error();
  console.log("aws_staging_migrations_passed");
} catch {
  console.error("aws_staging_migration_failed; check approved schema and protected configuration");
  process.exitCode = 1;
}
