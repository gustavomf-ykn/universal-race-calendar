import { writeFileSync, renameSync, readFileSync } from "node:fs";
export function writeWorkerHealth(state: string) {
  const path = process.env.WORKER_HEALTH_FILE;
  if (!path) return;
  writeFileSync(path + ".tmp", JSON.stringify({ state, updatedAt: Date.now() }), { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
export function checkWorkerHealth(path: string, now = Date.now()) {
  const record = JSON.parse(readFileSync(path, "utf8")) as { state: string; updatedAt: number };
  return (
    ["available", "busy", "resource_wait"].includes(record.state) &&
    Number.isFinite(record.updatedAt) &&
    now - record.updatedAt >= -5000 &&
    now - record.updatedAt <= 60000
  );
}
