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
