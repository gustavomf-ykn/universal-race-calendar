import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prisma, claimTask, enqueueTask } from "@race-calendar/database";
import { selectedTaskIds } from "../packages/database/src/tasks.js";
import { buildApp } from "../apps/api/src/app.js";

const directory = mkdtempSync(join(tmpdir(), "race-selection-"));
const selection = join(directory, "tasks.json");
const originalSelection = process.env.WORKER_TASK_SELECTION_FILE;
afterAll(() => {
  if (originalSelection === undefined) delete process.env.WORKER_TASK_SELECTION_FILE;
  else process.env.WORKER_TASK_SELECTION_FILE = originalSelection;
  rmSync(directory, { recursive: true });
});
it("fails closed for missing, malformed and invalid selection files", () => {
  process.env.WORKER_TASK_SELECTION_FILE = selection;
  expect(() => selectedTaskIds()).toThrow("task_selection_invalid");
  for (const value of ["{", "null", "{}", '[""]', "[1]"]) {
    writeFileSync(selection, value);
    expect(() => selectedTaskIds()).toThrow("task_selection_invalid");
  }
  writeFileSync(selection, "[]");
  expect(selectedTaskIds()).toEqual([]);
});

describe.skipIf(!process.env.DATABASE_URL)("selective acquisition and administrative holds", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const owner = "hold-test-" + randomUUID();
  const headers = { "x-api-key": "test-internal-key" };
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    process.env.INTERNAL_API_KEY = headers["x-api-key"];
    app = await buildApp();
  });
  afterAll(async () => {
    if (!app) return;
    await prisma.adminAudit.deleteMany({
      where: { taskId: { in: (await prisma.collectionTask.findMany({ where: { ownerId: owner } })).map((t) => t.id) } },
    });
    await prisma.collectionTask.deleteMany({ where: { ownerId: owner } });
    await app.close();
  });
  it("keeps old requests untouched, audits holds once and recovers only selected leases", async () => {
    const old = await enqueueTask(owner, "old", "ticketsports", "calendar", { quantity: 120 });
    const chosen = await enqueueTask(owner, "chosen", "ticketsports", "calendar", { quantity: 1 });
    const hold = (authorized = true) =>
      app.inject({
        method: "POST",
        url: `/v1/tasks/${old.id}/hold`,
        headers: authorized ? headers : {},
        payload: { hold: true, reason: "Preserve old request" },
      });
    expect((await hold(false)).statusCode).toBe(401);
    const held = await hold();
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json()).toMatchObject({ executionHold: true, status: "queued", attempt: 0 });
    expect((await hold()).statusCode).toBe(200);
    expect(await prisma.adminAudit.count({ where: { taskId: old.id } })).toBe(1);
    process.env.WORKER_TASK_SELECTION_FILE = selection;
    writeFileSync(selection, "[]");
    expect(await claimTask(["ticketsports"])).toBeNull();
    writeFileSync(selection, JSON.stringify([old.id]));
    expect(await claimTask(["ticketsports"])).toBeNull();
    writeFileSync(selection, JSON.stringify([chosen.id]));
    const running = await claimTask(["ticketsports"]);
    expect(running?.id).toBe(chosen.id);
    await prisma.collectionTask.update({ where: { id: chosen.id }, data: { leaseUntil: new Date(0) } });
    writeFileSync(selection, "[]");
    expect(await claimTask(["ticketsports"])).toBeNull();
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: chosen.id } })).attempt).toBe(1);
    writeFileSync(selection, JSON.stringify([chosen.id]));
    expect((await claimTask(["ticketsports"]))?.attempt).toBe(2);
    await prisma.collectionTask.update({ where: { id: chosen.id }, data: { status: "completed" } });
    delete process.env.WORKER_TASK_SELECTION_FILE;
    // The legacy two-argument function must also respect the persistent hold.
    expect(await claimTask(["ticketsports"])).toBeNull();
    expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      status: "queued",
      attempt: 0,
      executionHold: true,
    });
    const release = await app.inject({
      method: "POST",
      url: `/v1/tasks/${old.id}/hold`,
      headers,
      payload: { hold: false, reason: "Explicit release" },
    });
    expect(release.statusCode, release.body).toBe(200);
    expect((await claimTask(["ticketsports"]))?.id).toBe(old.id);
  });
});
