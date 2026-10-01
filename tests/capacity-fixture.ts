import { beforeAll } from "vitest";
import { prisma } from "@race-calendar/database";

// Synthetic allocations/Storage metadata belong only to the disposable test DB.
// Runtime code has no test-mode switch that bypasses the guard.
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const url = new URL(process.env.DATABASE_URL);
  if (!["127.0.0.1", "localhost", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
    throw Error("isolated_database_required");
  await prisma.$executeRawUnsafe("CREATE SCHEMA IF NOT EXISTS storage");
  await prisma.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS storage.objects (id TEXT PRIMARY KEY,metadata JSONB)");
  await prisma.$executeRawUnsafe(`UPDATE "CatalogCapacity" SET "databaseBudgetBytes"=1000000000000,"storageBudgetBytes"=1000000000000,
    "databaseHeadroomBytes"=16777216,"storageHeadroomBytes"=1048576,"confirmedAt"=now() WHERE id=1`);
});
