import { AsyncLocalStorage } from "node:async_hooks";
import type { CollectionTask, Prisma } from "@prisma/client";
import { assertCapacity } from "./capacity.js";
const context = new AsyncLocalStorage<CollectionTask>();
export function setTaskLease(task: CollectionTask) {
  context.enterWith(task);
}
export async function assertTaskLease(tx: Prisma.TransactionClient, growthBytes = 65536) {
  const task = context.getStore();
  if (!task) { await assertCapacity(tx, growthBytes); return; }
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "CollectionTask" WHERE id=${task.id}
    AND status='running' AND "leaseToken"=${task.leaseToken} AND "leaseUntil">now() FOR UPDATE`;
  if (!rows.length) throw new Error("lease_lost");
  await assertCapacity(tx, growthBytes);
}
