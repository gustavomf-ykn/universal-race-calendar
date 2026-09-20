// Node.js 18+. Uso:
// node examples/javascript_client.mjs https://openresults.run/evento/slug/

import { writeFile } from "node:fs/promises";

const apiBase = (process.env.SCRAPER_OPENRESULTS_API ||
  "https://scraper-openresults-gustavomf-ykn.onrender.com").replace(/\/$/, "");
const eventUrl = process.argv[2];
if (!eventUrl) throw new Error("Informe uma URL https://openresults.run/evento/<slug>/");

async function json(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
  return body;
}

const accepted = await json("/api/results/scrape", {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({scope: {mode: "single", url: eventUrl}}),
});

let job;
do {
  await new Promise(resolve => setTimeout(resolve, 2000));
  job = await json(`/api/jobs/${accepted.job_id}`);
  console.log(`${job.progress}% ${job.status}: ${job.stage}`);
} while (!["completed", "completed_with_warnings", "failed"].includes(job.status));

if (job.status === "failed") throw new Error(job.error || "Falha na extração");
if (!job.download_ready) {
  console.log("Concluído sem arquivo:", job.warnings || []);
  process.exit(0);
}

const response = await fetch(`${apiBase}/api/jobs/${accepted.job_id}/download`);
if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
const isZip = response.headers.get("content-type")?.includes("zip");
const filename = isZip ? "openresults_resultados.zip" : "openresults_resultados.xlsx";
await writeFile(filename, Buffer.from(await response.arrayBuffer()));
console.log(`Salvo em ${filename}`);
