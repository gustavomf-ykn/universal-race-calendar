import { prisma } from "./index.js";
import { TaskConflict, stableJson } from "./tasks.js";
import type { CollectionTask, Prisma } from "@prisma/client";
export const requestSources = ["ticketsports", "corridasbr", "openresults"] as const;
export type RequestSource = (typeof requestSources)[number];
export function requestSource(url: string, scope?: string): RequestSource {
  if (requestSources.includes(scope as RequestSource)) return scope as RequestSource;
  const hostname = new URL(url).hostname;
  if (hostname === "ticketsports.com.br" || hostname.endsWith(".ticketsports.com.br")) return "ticketsports";
  if (hostname === "corridasbr.com.br" || hostname.endsWith(".corridasbr.com.br")) return "corridasbr";
  if (hostname === "openresults.run" || hostname.endsWith(".openresults.run")) return "openresults";
  throw Error("source_request_scope_required");
}
export class SourceBudgetDeferred extends Error {
  constructor(readonly retryAt: Date) {
    super("source_budget_wait");
    this.name = "SourceBudgetDeferred";
  }
}
export class SourceCircuitOpen extends Error {
  constructor(readonly retryAt: Date | null = null) {
    super("source_access_blocked");
    this.name = "SourceCircuitOpen";
  }
}
export async function waitForSourceRequest(source: RequestSource) {
  for (;;) {
    const rows = await prisma.$queryRaw<Array<{ decision: string; retryAt: Date | null }>>`
      SELECT * FROM reserve_source_request(${source})`;
    const result = rows[0];
    if (result?.decision === "allowed") return;
    if (result?.decision === "blocked") throw new SourceCircuitOpen(result.retryAt);
    if (result?.decision === "budget" && result.retryAt) throw new SourceBudgetDeferred(result.retryAt);
    if (result?.decision !== "spacing" || !result.retryAt) throw Error("source_request_control_invalid");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(60000, Math.max(1, result.retryAt!.getTime() - Date.now() + 1))),
    );
  }
}
export async function deferSourceTask(
  task: CollectionTask,
  progress: Prisma.InputJsonValue,
  error: SourceBudgetDeferred | SourceCircuitOpen,
) {
  const rows = await prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT defer_source_task(${task.id},${task.leaseToken},${JSON.stringify(progress)}::jsonb,
      ${error.retryAt},${error instanceof SourceCircuitOpen}) AS ok`;
  return rows[0]?.ok === true;
}
export async function blockSourceRequests(source: RequestSource, retryAt: Date | null = null) {
  await prisma.$executeRaw`SELECT block_source_requests(${source},${retryAt})`;
}
export async function observeSourceResponse(
  url: string,
  scope: string | undefined,
  status: number,
  retryAfter?: string,
) {
  if (![401, 403, 429].includes(status)) return;
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const moment = retryAfter
    ? Number.isFinite(seconds)
      ? Date.now() + Math.max(0, seconds) * 1000
      : Date.parse(retryAfter)
    : NaN;
  await blockSourceRequests(requestSource(url, scope), Number.isFinite(moment) ? new Date(moment) : null);
}
export function publicSourceControl(
  gate: {
    source: string;
    windowStart: Date;
    requestCount: number;
    limitPerHour: number;
    minDelayMs: number;
    blockedAt: Date | null;
    blockedUntil: Date | null;
    blockReason: string | null;
  },
  now = new Date(),
) {
  const expired = gate.windowStart.getTime() + 3600000 <= now.getTime();
  const resetAt = new Date(
    (expired ? Math.floor(now.getTime() / 3600000) * 3600000 : gate.windowStart.getTime()) + 3600000,
  );
  return {
    source: gate.source,
    requestsUsed: expired ? 0 : gate.requestCount,
    limitPerHour: gate.limitPerHour,
    minDelayMs: gate.minDelayMs,
    resetAt,
    blockedAt: gate.blockedAt,
    blockedUntil: gate.blockedUntil,
    blockReason: gate.blockReason,
  };
}
async function mutateSourceControl(
  source: RequestSource,
  actorId: string,
  key: string,
  action: "resume_source_requests" | "configure_source_requests",
  payload: { reason: string; limitPerHour?: number; minDelayMs?: number },
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('race-task-acquisition'))`;
    const previous = await tx.adminAudit.findFirst({
      where: {
        actorId,
        action: { in: ["resume_source_requests", "configure_source_requests"] },
        details: { path: ["idempotencyKey"], equals: key },
      },
    });
    if (previous) {
      const details = previous.details as Record<string, Prisma.JsonValue>;
      if (
        previous.action !== action ||
        details.source !== source ||
        stableJson(details.payload) !== stableJson(payload)
      )
        throw new TaskConflict("idempotency_conflict");
      return details.result;
    }
    await tx.sourceRequestControl.upsert({
      where: { source },
      create: {
        source,
        windowStart: new Date(Math.floor(Date.now() / 3600000) * 3600000),
      },
      update: {},
    });
    await tx.$queryRaw`SELECT source FROM "SourceRequestControl" WHERE source=${source} FOR UPDATE`;
    const gate = await tx.sourceRequestControl.findUniqueOrThrow({ where: { source } });
    if (action === "resume_source_requests" && gate.blockedUntil && gate.blockedUntil > new Date())
      throw new TaskConflict("source_cooldown_active");
    const updated = await tx.sourceRequestControl.update({
      where: { source },
      data: {
        ...(action === "resume_source_requests"
          ? { blockedAt: null, blockedUntil: null, blockReason: null }
          : {
              limitPerHour: payload.limitPerHour ?? gate.limitPerHour,
              minDelayMs: payload.minDelayMs ?? gate.minDelayMs,
            }),
        updatedAt: new Date(),
      },
    });
    // Clearing a block never grants extra hourly requests or releases other hold reasons.
    if (action === "resume_source_requests")
      await tx.collectionTask.updateMany({
        where: { source, status: "queued", executionHold: true, holdReason: "source_access_blocked" },
        data: { executionHold: false, holdReason: null, errorCode: null, updatedAt: new Date() },
      });
    const result = JSON.parse(JSON.stringify(publicSourceControl(updated))) as Prisma.InputJsonObject;
    await tx.adminAudit.create({
      data: { actorId, action, details: { source, payload, idempotencyKey: key, result } },
    });
    return result;
  });
}
export function resumeSourceRequests(source: RequestSource, actorId: string, reason: string, key: string) {
  return mutateSourceControl(source, actorId, key, "resume_source_requests", { reason });
}
export function configureSourceRequests(
  source: RequestSource,
  actorId: string,
  payload: { reason: string; limitPerHour: number; minDelayMs: number },
  key: string,
) {
  if (
    !Number.isInteger(payload.limitPerHour) ||
    payload.limitPerHour < 1 ||
    payload.limitPerHour > 100 ||
    !Number.isInteger(payload.minDelayMs) ||
    payload.minDelayMs < 1000 ||
    payload.minDelayMs > 60000
  )
    throw new TaskConflict("source_request_limits_invalid");
  return mutateSourceControl(source, actorId, key, "configure_source_requests", payload);
}
