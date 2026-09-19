// No connection is opened and no values/errors from URL parsers are emitted.
const ref = "sggrijhyblejlgimgzzc";
try {
  if (process.env.SUPABASE_URL !== `https://${ref}.supabase.co`) throw new Error();
  const kind = process.argv[2];
  if (!["typescript", "python"].includes(kind)) throw new Error();
  const names = kind === "python" ? ["WORKER_DATABASE_URL"] : ["DATABASE_URL", "DIRECT_URL"];
  for (const name of names) {
    const url = new URL(process.env[name]);
    const identity =
      (url.hostname === `db.${ref}.supabase.co` && url.username === "postgres") ||
      (url.hostname.endsWith(".pooler.supabase.com") && url.username === `postgres.${ref}`);
    if (
      !identity ||
      !url.password ||
      url.pathname !== "/postgres" ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      (url.port && url.port !== "5432") ||
      !["require", "verify-full"].includes(url.searchParams.get("sslmode")) ||
      (kind === "python" && url.searchParams.has("schema"))
    )
      throw new Error();
  }
  if (kind === "python" && !process.env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")) throw new Error();
  console.log("staging_runner_configuration_passed");
} catch {
  console.error("staging_runner_configuration_rejected: check required staging secrets, project, port and SSL");
  process.exitCode = 1;
}
