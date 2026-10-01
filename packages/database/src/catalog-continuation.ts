import { createHash } from "node:crypto";
import { prisma } from "./index.js";
import { enqueueTask, stableJson, TaskConflict } from "./tasks.js";
import type { Prisma } from "@prisma/client";

/** Identifies persisted work, excluding timestamps and presentation counters. */
export function catalogCheckpoint(sync: { page: number; cursor: number; snapshot: unknown }): string {
  return createHash("sha256")
    .update(stableJson({ page: sync.page, cursor: sync.cursor, snapshot: sync.snapshot }))
    .digest("hex");
}

/** Restart-safe coordinator shared by both executor queues, never runs source HTTP. */
export async function coordinateCatalogSyncs(limit = 50): Promise<number> {
  const candidates = await prisma.catalogSync.findMany({
    where: {
      status: "ready",
      OR: [
        { options: { path: ["autoContinue"], equals: true } },
        { options: { path: ["pauseRequested"], equals: true } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let queued = 0;
  for (const { id } of candidates) {
    queued += await prisma.$transaction(async (tx) => {
      // The API's manual continuation takes the same lock. Concurrent coordinators cannot fork a checkpoint.
      await tx.$queryRaw`SELECT id FROM "CatalogSync" WHERE id=${id} FOR UPDATE`;
      const sync = await tx.catalogSync.findUniqueOrThrow({ where: { id } });
      const options = sync.options as Record<string, unknown>;
      if (sync.status !== "ready") return 0;
      const where = { kind: "catalog-sync", payload: { path: ["syncId"], equals: id } };
      if (options.pauseRequested === true) {
        if (!(await tx.collectionTask.count({ where: { ...where, status: "running" } })))
          await tx.catalogSync.update({ where: { id }, data: { status: "paused", updatedAt: new Date() } });
        return 0;
      }
      if (options.autoContinue !== true) return 0;
      // A metadata task may have closed this source even when the last
      // discovery step succeeded. Preserve the checkpoint until it is resumed.
      if (await tx.sourceRequestControl.count({ where: { source: sync.source, blockedAt: { not: null } } })) return 0;
      if (await tx.collectionTask.count({ where: { ...where, status: { in: ["queued", "running"] } } })) return 0;
      const last = await tx.collectionTask.findFirst({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
      if (!last || last.executionHold) return 0;
      if (last.status !== "completed") {
        await tx.catalogSync.update({
          where: { id },
          data: {
            status: last.status === "cancelled" ? "paused" : "blocked",
            coverage: last.errorCode ?? "catalog_step_not_completed",
            updatedAt: new Date(),
          },
        });
        return 0;
      }
      const checkpointHash = catalogCheckpoint(sync);
      if ((last.payload as Record<string, unknown>).checkpointHash === checkpointHash) {
        await tx.catalogSync.update({
          where: { id },
          data: {
            status: "limited",
            coverage: "catalog_checkpoint_not_advancing",
            updatedAt: new Date(),
          },
        });
        return 0;
      }
      const key = createHash("sha256").update(`catalog-auto:${id}:${checkpointHash}`).digest("hex");
      await enqueueTask(
        sync.ownerId,
        key,
        sync.source,
        "catalog-sync",
        {
          ...options,
          syncId: id,
          checkpointHash,
        } as Parameters<typeof enqueueTask>[4],
        tx,
      );
      return 1;
    });
  }
  return queued;
}

export async function controlCatalogSync(id: string, actorId: string, action: "pause" | "resume", key: string) {
  return prisma.$transaction(async (tx) => {
    // Acquisition uses this advisory lock, so no queued task starts halfway through a pause.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('race-task-acquisition'))`;
    await tx.$queryRaw`SELECT id FROM "CatalogSync" WHERE id=${id} FOR UPDATE`;
    const sync = await tx.catalogSync.findUnique({ where: { id } });
    if (!sync) throw new TaskConflict("sync_not_found");
    const previous = await tx.adminAudit.findFirst({
      where: {
        actorId,
        action: { in: ["catalog-sync-pause", "catalog-sync-resume"] },
        details: { path: ["idempotencyKey"], equals: key },
      },
    });
    if (previous) {
      if (previous.action !== `catalog-sync-${action}` || (previous.details as { syncId: string }).syncId !== id)
        throw new TaskConflict("idempotency_conflict");
      return sync;
    }
    if (["completed", "limited"].includes(sync.status)) throw new TaskConflict("scope_completed_or_limited");
    const options = sync.options as Record<string, unknown>;
    const where = { kind: "catalog-sync", payload: { path: ["syncId"], equals: id } };
    if (action === "pause") {
      if (options.pauseRequested === true) return sync;
      await tx.collectionTask.updateMany({
        where: { ...where, status: "queued", executionHold: false },
        data: { executionHold: true, holdReason: "catalog_sync_paused", updatedAt: new Date() },
      });
    } else {
      await tx.collectionTask.updateMany({
        where: { ...where, status: "queued", executionHold: true, holdReason: "catalog_sync_paused" },
        data: { executionHold: false, holdReason: null, updatedAt: new Date() },
      });
      if (!(await tx.collectionTask.count({ where: { ...where, status: { in: ["queued", "running"] } } }))) {
        await enqueueTask(
          actorId,
          key,
          sync.source,
          "catalog-sync",
          {
            ...options,
            pauseRequested: false,
            syncId: id,
            checkpointHash: catalogCheckpoint(sync),
          } as Prisma.InputJsonValue,
          tx,
        );
      }
    }
    const running = await tx.collectionTask.count({ where: { ...where, status: "running" } });
    const updated = await tx.catalogSync.update({
      where: { id },
      data: {
        options: { ...options, pauseRequested: action === "pause" } as Prisma.InputJsonValue,
        status: action === "pause" && !running ? "paused" : "ready",
        updatedAt: new Date(),
      },
    });
    await tx.adminAudit.create({
      data: { actorId, action: `catalog-sync-${action}`, details: { syncId: id, idempotencyKey: key } },
    });
    return updated;
  });
}
