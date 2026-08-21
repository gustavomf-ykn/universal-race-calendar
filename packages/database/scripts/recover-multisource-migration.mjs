import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

const migrationName = "20260821000000_multisource_catalog";
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const datasourceUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const prisma = new PrismaClient(datasourceUrl ? { datasourceUrl } : undefined);

try {
  let failedMigrations;
  try {
    failedMigrations = await prisma.$queryRawUnsafe(
      `SELECT "logs"
       FROM "_prisma_migrations"
       WHERE "migration_name" = $1
         AND "finished_at" IS NULL
         AND "rolled_back_at" IS NULL
       ORDER BY "started_at" DESC
       LIMIT 1`,
      migrationName,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("_prisma_migrations") && (message.includes("42P01") || message.includes("does not exist"))) {
      console.log("Migration history does not exist yet; recovery is not needed.");
      process.exitCode = 0;
      failedMigrations = [];
    } else {
      throw error;
    }
  }

  if (failedMigrations.length) {
    const previousLogs = typeof failedMigrations[0]?.logs === "string" ? failedMigrations[0].logs : "No migration log was stored.";
    console.warn(`Recovering failed migration ${migrationName}.`);
    console.warn(previousLogs.slice(0, 4000));
    console.warn("Removing only the partial objects introduced by the failed migration.");
    await prisma.$transaction([
      prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "ImportCandidate" CASCADE'),
      prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "EventSourceReference" CASCADE'),
      prisma.$executeRawUnsafe(
        'ALTER TABLE "ImportRun" DROP COLUMN IF EXISTS "mode", DROP COLUMN IF EXISTS "cursor", DROP COLUMN IF EXISTS "candidateLimit", DROP COLUMN IF EXISTS "options"',
      ),
    ]);
    await prisma.$disconnect();

    const prismaCommand = process.platform === "win32" ? "prisma.cmd" : "prisma";
    const resolution = spawnSync(
      prismaCommand,
      ["migrate", "resolve", "--rolled-back", migrationName, "--schema", "prisma/schema.prisma"],
      { cwd: packageDirectory, env: process.env, stdio: "inherit" },
    );
    if (resolution.error) throw resolution.error;
    if (resolution.status !== 0) throw new Error(`Prisma migrate resolve exited with status ${resolution.status}.`);
  } else {
    console.log(`No failed ${migrationName} migration requires recovery.`);
  }
} finally {
  await prisma.$disconnect();
}
