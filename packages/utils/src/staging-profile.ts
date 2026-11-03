import { readFileSync } from "node:fs";
export type RuntimeProfile = {
  id: string; name: string; projectRef: string; supabaseUrl: string;
  catalogPilot: { states: string[]; batchSize: number; prefixLimit: number; collectionQuantity: number };
};
export function runtimeProfile(env: Record<string, string | undefined> = process.env): RuntimeProfile | null {
  if (!env.RUNFINDER_PROFILE) return null;
  try {
    if (!env.RUNFINDER_PROFILE_CONFIG) throw Error();
    const config = JSON.parse(readFileSync(env.RUNFINDER_PROFILE_CONFIG, "utf8"));
    const p = config.profiles?.[env.RUNFINDER_PROFILE] as RuntimeProfile;
    if (config.version !== 1 || !p || p.id !== env.RUNFINDER_PROFILE ||
      !/^[a-z]{20}$/.test(p.projectRef) || p.supabaseUrl !== "https://" + p.projectRef + ".supabase.co" ||
      !p.catalogPilot || p.catalogPilot.states.join(",") !== "SC" || p.catalogPilot.batchSize !== 5 ||
      p.catalogPilot.prefixLimit !== 25 || p.catalogPilot.collectionQuantity !== 5) throw Error();
    return p;
  } catch { throw Error("runtime_profile_invalid"); }
}
export function assertRuntimeDestination(env: Record<string, string | undefined>, names: string[]) {
  const p = runtimeProfile(env);
  if (!p) return;
  try {
    if (env.SUPABASE_URL !== p.supabaseUrl || env.EXPECTED_SUPABASE_PROJECT_REF !== p.projectRef) throw Error();
    for (const name of names) {
      const u = new URL(env[name] ?? "");
      const direct = u.hostname === "db." + p.projectRef + ".supabase.co" && u.username === "postgres";
      const session = u.hostname.endsWith(".pooler.supabase.com") && u.username === "postgres." + p.projectRef;
      if (!["postgres:", "postgresql:"].includes(u.protocol) || !(direct || session) || !u.password ||
        u.pathname !== "/postgres" || (u.port && u.port !== "5432") ||
        u.searchParams.getAll("sslmode").length !== 1 ||
        !["require", "verify-full"].includes(u.searchParams.get("sslmode") ?? "")) throw Error();
      if (name === "WORKER_DATABASE_URL" &&
        ["schema", "pgbouncer", "connection_limit", "pool_timeout"].some(k => u.searchParams.has(k))) throw Error();
    }
  } catch { throw Error("runtime_destination_rejected"); }
}
/** A Session Pooler shares a small connection budget across all native processes. */
export function stagingPrismaUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  if (!runtimeProfile(env)) return undefined;
  assertRuntimeDestination(env, ["DATABASE_URL"]);
  const url = new URL(env.DATABASE_URL!);
  // API and TS each get at most two persistent connections. Reserve room for
  // Python's short transactions, heartbeats, the supervisor and diagnostics.
  const requested = url.searchParams.getAll("connection_limit");
  if (requested.length > 1 || (requested[0] !== undefined && !/^[1-9][0-9]*$/.test(requested[0])))
    throw Error("runtime_pool_configuration_invalid");
  url.searchParams.set("connection_limit", requested[0] === "1" ? "1" : "2");
  url.searchParams.set("pool_timeout", "15");
  return url.toString();
}
/** Runs before enqueue as well as before worker I/O. Never silently truncate an intention. */
export function assertPilotTask(kind: string, payload: Record<string, unknown>) {
  const p = runtimeProfile();
  if (!p) return;
  const cap = p.catalogPilot;
  const checkStates = (required: boolean) => {
    if (payload.states === undefined && !required) return;
    if (!Array.isArray(payload.states) || !payload.states.length ||
      payload.states.some(s => !cap.states.includes(String(s)))) throw Error("pilot_scope_exceeded");
  };
  if (kind === "calendar") {
    if (!Number.isInteger(payload.quantity) || Number(payload.quantity) > cap.collectionQuantity) throw Error("pilot_scope_exceeded");
    checkStates(true);
  }
  if (kind === "discover") {
    if (Number(payload.limit) > cap.collectionQuantity || Number(payload.maxPages) > 1) throw Error("pilot_scope_exceeded");
  }
  if (kind === "catalog-sync") {
    checkStates(true);
    if (Number(payload.batchSize) > cap.batchSize || Number(payload.prefixLimit ?? 10000) > cap.prefixLimit ||
      Number(payload.snapshotLimit ?? 250) > 250) throw Error("pilot_scope_exceeded");
  }
  if (["catalog", "catalog-process", "curate-batch"].includes(kind)) {
    if (Number(payload.candidateLimit ?? payload.limit ?? 10000) > cap.collectionQuantity) throw Error("pilot_scope_exceeded");
  }
}
