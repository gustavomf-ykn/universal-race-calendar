/** Read-only capacity inventory. This does not authorize a load or change a plan. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stagingRef = "sggrijhyblejlgimgzzc";

export function validateCapacityDestination(environment, env) {
  let uri;
  try { uri = new URL(env.DATABASE_URL); } catch { throw Error("capacity_destination_invalid"); }
  if (!["postgresql:", "postgres:"].includes(uri.protocol)) throw Error("capacity_destination_invalid");
  if (environment === "local-test") {
    if (!["127.0.0.1", "localhost", "postgres"].includes(uri.hostname) || !uri.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    return;
  }
  if (environment !== "race-platform-staging" ||
      env.SUPABASE_URL !== `https://${stagingRef}.supabase.co` || uri.pathname !== "/postgres")
    throw Error("staging_identity_required");
  const direct = uri.hostname === `db.${stagingRef}.supabase.co`;
  const pooler = uri.hostname.endsWith(".pooler.supabase.com") &&
    decodeURIComponent(uri.username).endsWith(`.${stagingRef}`);
  if ((!direct && !pooler) || !["require", "verify-full"].includes(uri.searchParams.get("sslmode")))
    throw Error("staging_identity_required");
}

const unavailable = (reason = "measurement_unavailable") => ({ status: "unavailable", value: null, reason });

export async function inspectCatalogCapacity(db) {
  async function read(run) {
    return db.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '5000ms'`;
      return run(tx);
    }, { maxWait: 5000, timeout: 10000 });
  }
  async function metric(run) {
    try { return { status: "measured", value: await read(run), reason: null }; }
    catch { return unavailable(); } // Never expose provider errors/connection details.
  }
  const currentDatabase = await metric(async tx => {
    const rows = await tx.$queryRaw`SELECT pg_database_size(current_database())::text AS bytes`;
    return rows[0].bytes;
  });
  const clusterDatabases = await metric(async tx => {
    const rows = await tx.$queryRaw`SELECT sum(pg_database_size(datname))::text AS bytes FROM pg_database`;
    return rows[0].bytes;
  });
  const publicTables = await metric(tx => tx.$queryRaw`
    SELECT c.relname AS table, pg_total_relation_size(c.oid)::text AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
    ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10`);
  const catalogRecords = await metric(async tx => {
    const rows = await tx.$queryRaw`
      SELECT count(*)::int AS editions,
        count(*) FILTER (WHERE "publicationStatus"='published')::int AS published,
        count(*) FILTER (WHERE country IS NULL OR country='')::int AS "countryMissing",
        count(*) FILTER (WHERE modality IN ('road','trail'))::int AS "roadOrTrail"
      FROM "Event"`;
    return rows[0];
  });
  const queuedWork = await metric(tx => tx.$queryRaw`
    SELECT source,kind,status,"executionHold" AS held,count(*)::int AS tasks
    FROM "CollectionTask" WHERE status IN ('queued','running')
    GROUP BY source,kind,status,"executionHold" ORDER BY source,kind,status,"executionHold"`);
  let storage = unavailable("storage_visibility_unconfirmed");
  try {
    storage = await read(async tx => {
      const present = await tx.$queryRaw`SELECT to_regclass('storage.objects') IS NOT NULL AS present`;
      if (!present[0].present) return unavailable("storage_schema_absent");
      // SELECT privilege alone is insufficient: RLS can silently hide objects.
      const visibility = await tx.$queryRaw`
        SELECT has_table_privilege(c.oid,'SELECT') AND
          (NOT c.relrowsecurity OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolbypassrls)
           OR (pg_has_role(c.relowner,'USAGE') AND NOT c.relforcerowsecurity)) AS complete
        FROM pg_class c WHERE c.oid='storage.objects'::regclass`;
      if (!visibility[0]?.complete) return unavailable("storage_visibility_unconfirmed");
      const rows = await tx.$queryRaw`
        SELECT count(*)::int AS objects,
          count(*) FILTER (WHERE coalesce(metadata->>'size','') !~ '^[0-9]+$')::int AS unknown,
          coalesce(sum(CASE WHEN metadata->>'size' ~ '^[0-9]+$'
            THEN (metadata->>'size')::numeric ELSE 0 END),0)::text AS bytes
        FROM storage.objects`;
      if (rows[0].unknown) return unavailable("storage_object_size_missing");
      return { status: "measured", value: { bytes: rows[0].bytes, objects: rows[0].objects }, reason: null };
    });
  } catch { storage = unavailable(); }
  return {
    measuredAt: new Date().toISOString(), currentDatabase, clusterDatabases, publicTables, catalogRecords, queuedWork, storage,
    limitsVerified: false, loadAuthorized: false,
    limitations: ["project_measurement_not_organization_billing", "wal_and_disk_not_measured", "capacity_guard_pending"],
  };
}

async function main() {
  let db;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !args[0].startsWith("--environment=")) throw Error("capacity_arguments_invalid");
    validateCapacityDestination(args[0].slice("--environment=".length), process.env);
    db = (await import("@race-calendar/database")).prisma;
    const report = await inspectCatalogCapacity(db);
    console.log(JSON.stringify(report));
    if ([report.currentDatabase, report.clusterDatabases, report.storage].some(m => m.status !== "measured"))
      process.exitCode = 2;
  } catch {
    console.error("catalog_capacity_inventory_failed; check environment and protected credentials");
    process.exitCode = 1;
  } finally { if (db) await db.$disconnect(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
