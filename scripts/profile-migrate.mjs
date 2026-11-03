import { spawnSync } from "node:child_process";
import { assertRuntimeDestination, runtimeProfile } from "@race-calendar/utils";
import { prisma } from "@race-calendar/database";
try {
  if (!runtimeProfile()) throw Error();
  assertRuntimeDestination(process.env, ["DATABASE_URL", "DIRECT_URL"]);
  const tables = await prisma.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  if (tables.length && !tables.some(t => t.tablename === "_prisma_migrations")) throw Error();
  if (tables.some(t => t.tablename === "CollectionTask")) {
    const rows = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM "CollectionTask" WHERE status IN (\'queued\',\'running\')');
    const workers = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM "WorkerPresence" WHERE "lastSeenAt">now()-interval \'75 seconds\' AND state<>\'stopped\'');
    const weekly = await prisma.$queryRawUnsafe('SELECT enabled FROM "CatalogWeeklySchedule" WHERE id=1');
    if (rows[0].n || workers[0].n || weekly[0]?.enabled) throw Error();
  }
  await prisma.$disconnect();
  const run = spawnSync(process.execPath, ["packages/database/node_modules/prisma/build/index.js",
    "migrate", "deploy", "--schema", "packages/database/prisma/schema.prisma"],
    {env: process.env, encoding: "utf8"});
  if (run.status !== 0) throw Error();
  console.log("profile_migrations_passed");
} catch {
  console.error("profile_migrations_failed; no provider values logged");
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
