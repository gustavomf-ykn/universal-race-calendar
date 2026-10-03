import {
  claimTask,
  heartbeatTask,
  finishTask,
  prisma,
  setTaskLease,
  newWorkerId,
  workerPresence,
  coordinateCatalogSyncs,
  coordinateCatalogReconciliations,
  processCatalogReconciliation,
  editionFailureCode,
  inspectLocalResources,
  assertLocalResources,
  LocalResourceDeferred,
  deferLocalResourceTask,
} from "@race-calendar/database";
import { syncCatalog } from "./catalog.js";
import { existsSync } from "node:fs";
import { BatchRun } from "./batch.js";
import { taskError } from "./task-error.js";
import { setSourceRequestGuard, enterSourceRequestScope } from "@race-calendar/sources";
import {
  requestSource,
  waitForSourceRequest,
  blockSourceRequests,
  deferSourceTask,
  SourceBudgetDeferred,
  SourceCircuitOpen,
  observeSourceResponse,
  assertCapacity,
  CapacityDeferred,
  deferCapacityTask,
} from "@race-calendar/database";
setSourceRequestGuard(async (url, scope) => {
  assertLocalResources();
  await assertCapacity();
  await waitForSourceRequest(requestSource(url, scope));
}, observeSourceResponse);
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
  const workerId = newWorkerId();
  const shouldStop = () =>
    stopping || Boolean(process.env.WORKER_STOP_FILE && existsSync(process.env.WORKER_STOP_FILE));
  const announce = () => {
    const resources = inspectLocalResources();
    return workerPresence(
      workerId,
      shouldStop() ? "stopping" : run.activeTaskId ? "busy" : resources.reason ? "resource_wait" : "available",
      run.activeTaskId,
      resources,
    );
  };
  let presenceTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await announce();
    presenceTimer = setInterval(() => {
      void announce().catch(() => {
        stopping = true;
        console.error("Calendar: connection lost; stopping before the next task.");
      });
    }, 20000);
    console.log("Calendar executor connected; waiting for panel requests.");
    let coordinatedAt = 0;
    let resourcesWaiting = false;
    while (!shouldStop() && run.canClaim()) {
      const resources = inspectLocalResources();
      if (resources.reason) {
        await announce();
        if (!resourcesWaiting) console.log("Calendar: local resources unavailable; waiting without acquiring tasks.");
        resourcesWaiting = true;
        if (run.options.batch) {
          run.reason = "local_resource_wait";
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (resourcesWaiting) {
        resourcesWaiting = false;
        await announce();
        console.log("Calendar: local resources available; waiting for requests.");
      }
      // Selective tests must never generate or consume successors outside their approved ID list.
      if (!process.env.WORKER_TASK_SELECTION_FILE && Date.now() - coordinatedAt >= 5000) {
        await coordinateCatalogSyncs();
        await coordinateCatalogReconciliations();
        coordinatedAt = Date.now();
      }
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
      await announce();
      console.log(`Calendar task ${task.id}: started.`);
      setTaskLease(task);
      enterSourceRequestScope(task.source);
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
        assertLocalResources();
        await assertCapacity();
        const input = task.payload as Record<string, unknown>;
        let status = "completed";
        if (task.kind === "catalog-sync") {
          progress = await syncCatalog(input);
        } else if (task.kind === "catalog-reconcile") {
          progress = await processCatalogReconciliation(task);
        } else if (task.kind === "calendar") {
          const importer = task.source === "ticketsports" ? importTicketSportsEvents : importCorridasBREvents;
          const quantity = Math.min(Number(input.quantity ?? 25), 500);
          let processed = 0,
            failed = 0;
          for (let offset = Number(input.offset ?? 0); processed < quantity; ) {
            assertLocalResources();
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
            assertLocalResources();
            progress = { stage: "catalog", runId, processed: run.processedCount };
            if (!(await heartbeatTask(task, progress))) throw new Error("lease_lost");
            run = await processCatalogImportRun(runId, 25);
          }
          progress = { stage: "catalog", runId, processed: run?.processedCount ?? 0, failed: run?.failedCount ?? 0 };
          if (run?.failedCount) status = "partial";
        } else if (task.kind === "check-source") {
          const result = await runSourceCheck(String(input.sourceId));
          progress = { stage: result.status };
          if (result.reasons.includes("source_access_blocked")) throw Error("source_access_blocked");
          const editionFailure = result.reasons.find((code) => editionFailureCode(new Error(code)));
          if (editionFailure) throw Error(editionFailure);
          if (result.status.includes("failed")) status = "failed";
        } else if (task.kind === "curate-event") {
          const result = await runAICurationForEvent(String(input.eventId), input);
          progress = { stage: result.status };
        } else if (task.kind === "curate-batch") {
          const result = await runAICurationBatch(input);
          progress = { stage: result.status };
        } else throw new Error("unsupported_task");
        await finishTask(task, status, progress, status === "failed" ? "collection_failed" : null);
      } catch (error) {
        if (error instanceof LocalResourceDeferred) {
          progress = { ...progress, stage: "local_resource_wait" };
          await deferLocalResourceTask(task, progress, error);
        } else if (error instanceof CapacityDeferred) {
          progress = { ...progress, stage: "capacity_wait" };
          await deferCapacityTask(task, progress, error);
        } else if (error instanceof SourceBudgetDeferred || error instanceof SourceCircuitOpen) {
          progress = {
            ...progress,
            stage: error instanceof SourceCircuitOpen ? "source_access_blocked" : "source_budget_wait",
          };
          await deferSourceTask(task, progress, error);
        } else {
          const failure = taskError(error);
          if (failure.code === "source_access_blocked" && ["ticketsports", "corridasbr"].includes(task.source))
            await blockSourceRequests(task.source as "ticketsports" | "corridasbr");
          if (!failure.retryable)
            await prisma.collectionTask.updateMany({
              where: {
                id: task.id,
                status: "running",
                leaseToken: task.leaseToken,
                leaseUntil: { gt: new Date() },
              },
              data: { maxAttempts: task.attempt },
            });
          await finishTask(task, "failed", progress, failure.code);
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(deadline);
      }
      const outcome = await prisma.collectionTask.findUnique({ where: { id: task.id }, select: { status: true } });
      run.tasks.push({ id: task.id, status: outcome?.status ?? "unknown" });
      if (run.tasks.length > 100) run.tasks.shift();
      run.activeTaskId = null;
      await announce();
      console.log(`Calendar task ${task.id}: ${outcome?.status ?? "unknown"}.`);
    }
  } catch {
    run.reason = "worker_failed";
    throw new Error("worker_failed");
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (presenceTimer) clearInterval(presenceTimer);
    await workerPresence(workerId, "stopped", null).catch(() => {});
    run.report();
    await prisma.$disconnect();
  }
}
runQueue().catch(() => {
  console.error("Worker stopped; inspect task history and database connectivity.");
  process.exitCode = 1;
});
