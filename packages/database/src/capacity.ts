import type { CollectionTask, Prisma } from "@prisma/client";
import { prisma } from "./index.js";
import { TaskConflict, stableJson } from "./tasks.js";

export const capacityReasons = [
  "capacity_unconfigured",
  "capacity_measurement_unavailable",
  "capacity_database_limit",
  "capacity_storage_limit",
] as const;
export function capacityGrowth(value: unknown) {
  return 65536 + Buffer.byteLength(JSON.stringify(value)) * 8;
}
export class CapacityDeferred extends Error {
  constructor(readonly reason: (typeof capacityReasons)[number]) {
    super(reason);
    this.name = "CapacityDeferred";
  }
}
export async function assertCapacity(tx: Prisma.TransactionClient = prisma, growthBytes = 65536) {
  const rows = await tx.$queryRaw<
    Array<{ decision: string }>
  >`SELECT check_catalog_capacity('database',${BigInt(growthBytes)}) AS decision`;
  const decision = rows[0]?.decision;
  if (decision === "allowed") return;
  if (capacityReasons.includes(decision as (typeof capacityReasons)[number]))
    throw new CapacityDeferred(decision as (typeof capacityReasons)[number]);
  throw Error("capacity_control_invalid");
}
export async function deferCapacityTask(
  task: CollectionTask,
  progress: Prisma.InputJsonValue,
  error: CapacityDeferred,
) {
  const rows = await prisma.$queryRaw<
    Array<{ ok: boolean }>
  >`SELECT defer_capacity_task(${task.id},${task.leaseToken},${JSON.stringify(progress)}::jsonb,${error.reason}) AS ok`;
  return rows[0]?.ok === true;
}
export async function readCapacity(tx: Prisma.TransactionClient = prisma) {
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`SELECT
    "databaseBudgetBytes"::text AS "databaseBudgetBytes", "storageBudgetBytes"::text AS "storageBudgetBytes",
    "databaseHeadroomBytes"::text AS "databaseHeadroomBytes", "storageHeadroomBytes"::text AS "storageHeadroomBytes",
    "databaseBytes"::text AS "databaseBytes", "storageBytes"::text AS "storageBytes",
    "confirmedAt", "databaseMeasuredAt", "storageMeasuredAt", "updatedAt",
    (SELECT coalesce(sum(bytes),0)::text FROM "CapacityReservation" WHERE "expiresAt">now()) AS "reservedStorageBytes"
    FROM "CatalogCapacity" WHERE id=1`;
  return rows[0];
}
type Allocation = {
  databaseBudgetBytes: string;
  storageBudgetBytes: string;
  databaseHeadroomBytes: string;
  storageHeadroomBytes: string;
  allocationConfirmed: true;
  reason: string;
};
function validateAllocation(payload: Allocation) {
  const names = ["databaseBudgetBytes", "storageBudgetBytes", "databaseHeadroomBytes", "storageHeadroomBytes"] as const;
  if (
    payload.allocationConfirmed !== true ||
    typeof payload.reason !== "string" ||
    payload.reason.length < 3 ||
    payload.reason.length > 500 ||
    names.some((name) => typeof payload[name] !== "string" || !/^[1-9][0-9]{0,12}$/.test(payload[name]))
  )
    throw new TaskConflict("capacity_allocation_invalid");
  if (
    BigInt(payload.databaseHeadroomBytes) < 16777216n ||
    BigInt(payload.storageHeadroomBytes) < 1048576n ||
    BigInt(payload.databaseBudgetBytes) <= BigInt(payload.databaseHeadroomBytes) ||
    BigInt(payload.storageBudgetBytes) <= BigInt(payload.storageHeadroomBytes)
  )
    throw new TaskConflict("capacity_allocation_invalid");
}
export async function controlCapacity(
  actorId: string,
  key: string,
  action: "configure" | "resume" | "refresh",
  payload: Allocation | { reason: string; resource?: "database" | "storage" },
) {
  if (action === "configure") validateAllocation(payload as Allocation);
  if (!payload.reason || payload.reason.length < 3 || payload.reason.length > 500)
    throw new TaskConflict("capacity_allocation_invalid");
  const resource = (payload as { resource?: string }).resource;
  if (action === "resume" && !["database", "storage"].includes(resource ?? ""))
    throw new TaskConflict("capacity_allocation_invalid");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('race-task-acquisition'))`;
    const previous = await tx.adminAudit.findFirst({
      where: {
        actorId,
        action: { in: ["capacity_configure", "capacity_resume", "capacity_refresh"] },
        details: { path: ["idempotencyKey"], equals: key },
      },
    });
    if (previous) {
      const details = previous.details as Record<string, Prisma.JsonValue>;
      if (previous.action !== `capacity_${action}` || stableJson(details.payload) !== stableJson(payload))
        throw new TaskConflict("idempotency_conflict");
      return details.result;
    }
    if (action === "configure") {
      const allocation = payload as Allocation;
      await tx.$executeRaw`UPDATE "CatalogCapacity" SET "databaseBudgetBytes"=${BigInt(allocation.databaseBudgetBytes)},
        "storageBudgetBytes"=${BigInt(allocation.storageBudgetBytes)},"databaseHeadroomBytes"=${BigInt(allocation.databaseHeadroomBytes)},
        "storageHeadroomBytes"=${BigInt(allocation.storageHeadroomBytes)},"confirmedAt"=now(),"updatedAt"=now() WHERE id=1`;
    }
    // Configuration never releases tasks. Resume requires fresh, complete measurements.
    let released = 0;
    if (action === "resume") {
      await assertCapacity(tx);
      if (resource === "storage") {
        const rows = await tx.$queryRaw<
          Array<{ decision: string }>
        >`SELECT check_catalog_capacity('storage') AS decision`;
        if (rows[0]?.decision !== "allowed") throw new TaskConflict(rows[0]?.decision ?? "capacity_control_invalid");
      }
      const update = await tx.collectionTask.updateMany({
        where: {
          status: "queued",
          executionHold: true,
          holdReason: "capacity_wait",
          progress: { path: ["capacityResource"], equals: resource! },
        },
        data: { executionHold: false, holdReason: null, errorCode: null, updatedAt: new Date() },
      });
      released = update.count;
    }
    let decisions: Record<string, string> = {};
    if (action === "refresh") {
      for (const selected of ["database", "storage"]) {
        const rows = await tx.$queryRaw<
          Array<{ decision: string }>
        >`SELECT check_catalog_capacity(${selected}) AS decision`;
        decisions = { ...decisions, [selected]: rows[0]?.decision ?? "capacity_control_invalid" };
      }
    }
    const result = JSON.parse(
      JSON.stringify({ ...(await readCapacity(tx)), released, decisions }),
    ) as Prisma.InputJsonObject;
    await tx.adminAudit.create({
      data: { actorId, action: `capacity_${action}`, details: { idempotencyKey: key, payload, result } },
    });
    return result;
  });
}
