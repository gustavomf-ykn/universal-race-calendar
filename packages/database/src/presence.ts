import { randomUUID } from "node:crypto";
import { prisma } from "./index.js";

export type PresenceRow = {
  id: string;
  runtime: string;
  capabilities: string[];
  state: string;
  activeTaskId: string | null;
  version: string;
  startedAt: Date;
  lastSeenAt: Date;
  ageSeconds: number;
};
export function presentWorker(row: PresenceRow) {
  return { ...row, state: row.state === "stopped" || row.ageSeconds > 75 ? "disconnected" : row.state };
}
export async function workerPresence(id: string, state: string, activeTaskId: string | null) {
  const version = process.env.WORKER_CODE_VERSION ?? process.env.GIT_SHA ?? "unknown";
  await prisma.$executeRaw`INSERT INTO "WorkerPresence" (id,runtime,capabilities,state,"activeTaskId",version)
    VALUES (${id},'typescript',ARRAY['ticketsports','corridasbr','maintenance'],${state},${activeTaskId},${version})
    ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,"activeTaskId"=EXCLUDED."activeTaskId","lastSeenAt"=now() WHERE "WorkerPresence".state<>'stopped'`;
}
export async function listWorkers() {
  const rows = await prisma.$queryRaw<
    PresenceRow[]
  >`SELECT *,extract(epoch FROM now()-"lastSeenAt")::float8 AS "ageSeconds"
    FROM "WorkerPresence" WHERE "lastSeenAt">now()-interval '7 days' ORDER BY "lastSeenAt" DESC LIMIT 100`;
  return rows.map(presentWorker);
}
export const newWorkerId = () => randomUUID();
