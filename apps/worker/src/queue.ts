import { claimTask, heartbeatTask, finishTask, prisma, setTaskLease } from "@race-calendar/database";
import { BatchRun } from "./batch.js";
import {
  importTicketSportsEvents,
  importCorridasBREvents,
  createCatalogImportRun,
  processCatalogImportRun,
  runSourceCheck,
  runAICurationForEvent,
  runAICurationBatch,
} from "@race-calendar/curation";

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
export async function runQueue() {
  const run = new BatchRun();
  const watchdog = run.watchdog();
  try {
    while (!stopping && run.canClaim()) {
      const task = await claimTask(["ticketsports", "corridasbr", "maintenance"]);
      if (!task) {
        if (run.options.batch) {
          run.reason = "queue_empty";
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      run.claimed++;
      run.activeTaskId = task.id;
      setTaskLease(task);
      let progress: Record<string, number | string> = { stage: "starting" };
      // Fail closed if the lease is lost: a stale executor must stop doing work.
      const heartbeat = setInterval(() => {
        void heartbeatTask(task, progress)
          .then((ok) => {
            if (!ok) process.exit(1);
          })
          .catch(() => process.exit(1));
      }, 20000);
      const deadline = setTimeout(() => process.exit(1), 1800000);
      try {
        const input = task.payload as Record<string, unknown>;
        let status = "completed";
        if (task.kind === "calendar") {
          const importer = task.source === "ticketsports" ? importTicketSportsEvents : importCorridasBREvents;
          const quantity = Math.min(Number(input.quantity ?? 25), 500);
          let processed = 0,
            failed = 0;
          for (let offset = Number(input.offset ?? 0); processed < quantity; ) {
            const result = await importer({
              ...input,
              quantity: Math.min(25, quantity - processed),
              offset,
              concurrency: 1,
              delayMs: 500,
            });
            processed += result.processedCount;
            failed += result.failedCount;
            progress = { processed, failed, requested: quantity, stage: "collecting" };
            if (!(await heartbeatTask(task, progress))) throw new Error("lease_lost");
            if (!result.processedCount) break;
            offset += result.processedCount;
          }
          if (failed) status = processed > failed ? "partial" : "failed";
        } else if (task.kind === "catalog" || task.kind === "catalog-process") {
          let runId = String(input.runId ?? (task.progress as Record<string, unknown>)?.runId ?? "");
          if (!runId) {
            const run = await createCatalogImportRun(input);
            if (!run) throw new Error("run_missing");
            runId = run.id;
          }
          progress = { stage: "catalog", runId };
          if (!(await heartbeatTask(task, progress))) throw new Error("lease_lost");
          // Each candidate is idempotently upserted; progress remains visible in ImportRun.
          let run = await processCatalogImportRun(runId, 25);
          while (run?.status === "ready") {
            progress = { stage: "catalog", runId, processed: run.processedCount };
            if (!(await heartbeatTask(task, progress))) throw new Error("lease_lost");
            run = await processCatalogImportRun(runId, 25);
          }
          progress = { stage: "catalog", runId, processed: run?.processedCount ?? 0, failed: run?.failedCount ?? 0 };
          if (run?.failedCount) status = "partial";
        } else if (task.kind === "check-source") {
          const result = await runSourceCheck(String(input.sourceId));
          progress = { stage: result.status };
          if (result.status.includes("failed")) status = "failed";
        } else if (task.kind === "curate-event") {
          const result = await runAICurationForEvent(String(input.eventId), input);
          progress = { stage: result.status };
        } else if (task.kind === "curate-batch") {
          const result = await runAICurationBatch(input);
          progress = { stage: result.status };
        } else throw new Error("unsupported_task");
        await finishTask(task, status, progress, status === "failed" ? "collection_failed" : null);
      } catch {
        await finishTask(task, "failed", progress, "collection_failed");
      } finally {
        clearInterval(heartbeat);
        clearTimeout(deadline);
      }
      const outcome = await prisma.collectionTask.findUnique({ where: { id: task.id }, select: { status: true } });
      run.tasks.push({ id: task.id, status: outcome?.status ?? "unknown" });
      if (run.tasks.length > 100) run.tasks.shift();
      run.activeTaskId = null;
    }
  } catch {
    run.reason = "worker_failed";
    throw new Error("worker_failed");
  } finally {
    if (watchdog) clearTimeout(watchdog);
    run.report();
    await prisma.$disconnect();
  }
}
runQueue().catch(() => {
  console.error("Worker stopped; inspect task history and database connectivity.");
  process.exitCode = 1;
});
