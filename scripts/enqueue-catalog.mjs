// GitHub Actions submits durable jobs; no collection is performed in the HTTP request.
const base = process.env.API_BASE_URL?.replace(/\/$/, "");
const key = process.env.API_KEY;
if (!base || !key) throw new Error("API_BASE_URL and API_KEY are required");
const version = await fetch(`${base}/v1/version`, { signal: AbortSignal.timeout(30000) });
if (!version.ok || (await version.json()).backendVersion !== "2.0.0")
  throw new Error("Unexpected deployment: verify API_BASE_URL and deployed version");
for (const source of ["ticketsports", "corridasbr"]) {
  const response = await fetch(`${base}/v1/collections`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
      "Idempotency-Key": `catalog-${process.env.GITHUB_RUN_ID ?? new Date().toISOString().slice(0, 10)}-${source}`,
    },
    body: JSON.stringify({ source, quantity: Number(process.env.QUANTITY ?? 100) }),
    signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 202) throw new Error(`Queue submission failed: ${source} HTTP ${response.status}`);
  const task = await response.json();
  console.log(JSON.stringify({ source, taskId: task.id, status: task.status }));
}
