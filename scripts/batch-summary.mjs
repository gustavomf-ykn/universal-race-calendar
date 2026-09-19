import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const worker = process.argv[2];
if (!["typescript", "python"].includes(worker)) throw new Error("invalid_worker");
let source;
try {
  source = JSON.parse(readFileSync("batch-report.json", "utf8"));
} catch {
  source = {};
}
const safe = {
  worker,
  reason: ["stopped", "task_limit", "duration_limit", "queue_empty", "worker_failed"].includes(source.reason)
    ? source.reason
    : "report_unavailable",
  claimed: Number.isSafeInteger(source.claimed) ? source.claimed : null,
  elapsedSeconds: Number.isSafeInteger(source.elapsedSeconds) ? source.elapsedSeconds : null,
  recoveryPending: source.recoveryPending === true,
  // IDs/status only; never serialize raw upstream payload or credentials.
  tasks: Array.isArray(source.tasks)
    ? source.tasks.slice(0, 100).map((t) => ({
        id: /^[\w-]{1,100}$/.test(t.id) ? t.id : "omitted",
        status: ["queued", "running", "completed", "partial", "failed", "cancelled"].includes(t.status)
          ? t.status
          : "unknown",
      }))
    : [],
  jobElapsedSecondsSoFar: Math.max(
    0,
    Math.round(Date.now() / 1000) - Number(process.env.JOB_STARTED_AT || Math.round(Date.now() / 1000)),
  ),
};
writeFileSync("batch-summary.json", JSON.stringify(safe, null, 2));
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## ${worker} staging batch\n\n\`\`\`json\n${JSON.stringify(safe, null, 2)}\n\`\`\`\n\nFinal job/step timings in Actions include preparation and artifact upload. No new collection was enqueued by this workflow.\n`,
  );
