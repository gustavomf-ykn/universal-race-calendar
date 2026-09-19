import { writeFileSync } from "node:fs";

export function workerOptions(env = process.env) {
  const mode = env.WORKER_MODE ?? "continuous";
  if (!["continuous", "batch"].includes(mode)) throw new Error("invalid_worker_mode");
  function limit(name: string, fallback: number, maximum: number) {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new Error("invalid_worker_limits");
    return Number(value);
  }
  return {
    batch: mode === "batch",
    maxTasks: limit("WORKER_MAX_TASKS", 3, 100),
    maxSeconds: limit("WORKER_MAX_SECONDS", 600, 3600),
  };
}

export class BatchRun {
  readonly started = performance.now();
  readonly options = workerOptions();
  claimed = 0;
  activeTaskId: string | null = null;
  tasks: Array<{ id: string; status: string }> = [];
  reason = "stopped";
  canClaim() {
    if (!this.options.batch) return true;
    if (this.claimed >= this.options.maxTasks) {
      this.reason = "task_limit";
      return false;
    }
    if ((performance.now() - this.started) / 1000 >= this.options.maxSeconds) {
      this.reason = "duration_limit";
      return false;
    }
    return true;
  }
  report(reason = this.reason) {
    const result = {
      worker: "typescript",
      mode: this.options.batch ? "batch" : "continuous",
      reason,
      claimed: this.claimed,
      activeTaskId: this.activeTaskId,
      tasks: this.tasks,
      elapsedSeconds: Math.round((performance.now() - this.started) / 1000),
      recoveryPending: this.activeTaskId !== null,
    };
    if (process.env.WORKER_REPORT_PATH) writeFileSync(process.env.WORKER_REPORT_PATH, JSON.stringify(result));
    console.log(JSON.stringify(result));
  }
  watchdog() {
    if (!this.options.batch) return undefined;
    return setTimeout(() => {
      // Do not release a lease while an uncancellable parser/transaction might still write.
      // Stop this process; a later run recovers the real expired lease through claim_task.
      try {
        this.report("duration_limit");
      } finally {
        process.exit(this.activeTaskId ? 75 : 0);
      }
    }, this.options.maxSeconds * 1000);
  }
}
