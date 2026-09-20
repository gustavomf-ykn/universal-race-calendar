import { pathToFileURL } from "node:url";

// Read only: validate the Storage secret even when no export is queued.
// Never emit headers, credentials, response bodies or provider errors.
export async function checkStagingStorage(env = process.env, request = fetch) {
  const base = "https://sggrijhyblejlgimgzzc.supabase.co";
  try {
    if (env.SUPABASE_URL !== base || !env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")) throw new Error();
    const response = await request(`${base}/storage/v1/bucket/race-exports`, {
      headers: { apikey: env.SUPABASE_SECRET_KEY },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    const bucket = await response.json();
    if (bucket.id !== "race-exports" || bucket.public !== false) throw new Error();
  } catch {
    throw new Error("staging_storage_check_failed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkStagingStorage();
    console.log("staging_private_storage_access_passed");
  } catch {
    console.error("staging_storage_check_failed");
    process.exitCode = 1;
  }
}
