import { AsyncLocalStorage } from "node:async_hooks";
import type { CollectionTask, Prisma } from "@prisma/client";
const context = new AsyncLocalStorage<CollectionTask>();
export function setTaskLease(task: CollectionTask) {
  context.enterWith(task);
}
export async function assertTaskLease(tx: Prisma.TransactionClient) {
  const task = context.getStore();
  if (!task) return;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "CollectionTask" WHERE id=${task.id}
    AND status='running' AND "leaseToken"=${task.leaseToken} AND "leaseUntil">now() FOR UPDATE`;
  if (!rows.length) throw new Error("lease_lost");
}
