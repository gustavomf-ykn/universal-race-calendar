// The workflow runs check-runner-env before this read-only connectivity check.
// Never print connection strings or database errors.
let prisma;
try {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("connect_timeout", "10");
  url.searchParams.set("pool_timeout", "10");
  process.env.DATABASE_URL = url.toString();
  ({ prisma } = await import("@race-calendar/database"));
  await prisma.$queryRawUnsafe('SELECT id FROM "CollectionTask" LIMIT 0');
  await prisma.$queryRawUnsafe('SELECT resources FROM "WorkerPresence" LIMIT 0');
  await prisma.$queryRawUnsafe("SELECT 'defer_local_resource_task(text,text,jsonb,text)'::regprocedure");
  await prisma.$queryRawUnsafe("SELECT task_queue_priority('catalog-sync',now(),now())");
  await prisma.$queryRawUnsafe('SELECT id,"parserVersion",sequence FROM "CatalogReconciliation" LIMIT 0');
  await prisma.$queryRawUnsafe('SELECT "runId","eventId",status FROM "CatalogReconciliationDecision" LIMIT 0');
  const cancellation =
    await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_constraint WHERE conrelid='"CatalogReconciliation"'::regclass
    AND conname='CatalogReconciliation_status_check' AND pg_get_constraintdef(oid) LIKE '%cancelled%'`);
  if (cancellation.length !== 1) throw new Error("catalog_reconciliation_schema_incomplete");
  console.log("staging_database_access_passed");
} catch {
  console.error("staging_database_check_failed");
  process.exitCode = 1;
} finally {
  try {
    await prisma?.$disconnect();
  } catch {
    console.error("staging_database_disconnect_failed");
    process.exitCode = 1;
  }
}
