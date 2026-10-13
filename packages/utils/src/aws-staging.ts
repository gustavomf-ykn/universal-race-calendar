/** AWS release artifacts are staging-only. Errors contain no connection values. */
export function assertAwsStaging(env: Record<string, string | undefined>, names: string[]) {
  if (env.HOSTING_TARGET !== "aws") return;
  const ref = "sggrijhyblejlgimgzzc";
  try {
    if (env.SUPABASE_URL !== `https://${ref}.supabase.co`) throw Error();
    for (const name of names) {
      const u = new URL(env[name] ?? "");
      const direct = u.hostname === `db.${ref}.supabase.co` && u.username === "postgres";
      const pool = u.hostname.endsWith(".pooler.supabase.com") && u.username === `postgres.${ref}`;
      if (
        !["postgres:", "postgresql:"].includes(u.protocol) ||
        !(direct || pool) ||
        !u.password ||
        u.pathname !== "/postgres" ||
        (u.port && u.port !== "5432") ||
        !["require", "verify-full"].includes(u.searchParams.get("sslmode") ?? "")
      )
        throw Error();
      if (
        name === "WORKER_DATABASE_URL" &&
        ["schema", "pgbouncer", "connection_limit", "pool_timeout"].some((k) => u.searchParams.has(k))
      )
        throw Error();
    }
  } catch {
    throw Error("aws_staging_configuration_rejected");
  }
}
