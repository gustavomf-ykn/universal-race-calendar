import { describe, it, expect, afterAll } from "vitest";
import { prisma, workerPresence, listWorkers } from "@race-calendar/database";
import { buildApp } from "../apps/api/src/app.js";
describe.skipIf(!process.env.DATABASE_URL)("worker presence authorization and lifecycle", () => {
  let isolated = false;
  afterAll(async () => {
    if (!isolated) return;
    await prisma.$executeRaw`DELETE FROM "WorkerPresence" WHERE id='presence-test'`;
  });
  it("reports idle, busy, stale and stopped without depending on task heartbeat", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated database required");
    isolated = true;
    await workerPresence("presence-test", "available", null);
    expect((await listWorkers()).find((w) => w.id === "presence-test")?.state).toBe("available");
    await workerPresence("presence-test", "busy", "task-test");
    expect((await listWorkers()).find((w) => w.id === "presence-test")?.state).toBe("busy");
    await prisma.$executeRaw`UPDATE "WorkerPresence" SET "lastSeenAt"=now()-interval '76 seconds' WHERE id='presence-test'`;
    expect((await listWorkers()).find((w) => w.id === "presence-test")?.state).toBe("disconnected");
    await workerPresence("presence-test", "stopped", null);
    expect((await listWorkers()).find((w) => w.id === "presence-test")?.state).toBe("disconnected");
    const app = await buildApp();
    try {
      expect((await app.inject({ url: "/v1/admin/workers" })).statusCode).toBe(401);
      expect(
        (await app.inject({ url: "/v1/admin/workers", headers: { authorization: "Bearer invalid" } })).statusCode,
      ).toBe(401);
      const response = await app.inject({ url: "/v1/admin/workers", headers: { "x-api-key": "test-internal-key" } });
      expect(response.statusCode).toBe(200);
      expect(response.json().staleAfterSeconds).toBe(75);
      const summary = await app.inject({ url: "/v1/executors", headers: { "x-api-key": "test-internal-key" } });
      expect(summary.statusCode).toBe(200);
      expect(summary.json().data.find((w: { id: string }) => w.id === "presence-test")).not.toHaveProperty(
        "activeTaskId",
      );
      expect((await app.inject({ url: "/v1/executors" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
