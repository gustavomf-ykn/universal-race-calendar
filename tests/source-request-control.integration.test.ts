import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  prisma,
  waitForSourceRequest,
  blockSourceRequests,
  deferSourceTask,
  SourceBudgetDeferred,
  SourceCircuitOpen,
  resumeSourceRequests,
  configureSourceRequests,
  publicSourceControl,
  coordinateCatalogSyncs,
} from "@race-calendar/database";
import { buildApp } from "../apps/api/src/app.js";
import { importTicketSportsEvents, importCorridasBREvents } from "@race-calendar/curation";
import { SourceAdapterRegistry } from "@race-calendar/sources";
import { ScraperHttpError } from "@race-calendar/scraper";

const enabled = Boolean(process.env.DATABASE_URL);
const owner = "source-control-test-" + randomUUID();
const source = "openresults";
describe.skipIf(!enabled)("shared source request controls on isolated PostgreSQL", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    process.env.INTERNAL_API_KEY = "test-internal-key";
    app = await buildApp();
  });
  beforeEach(async () => {
    await prisma.sourceRequestControl.deleteMany();
    await prisma.sourceRequestControl.create({
      data: { source, limitPerHour: 1, windowStart: new Date(Math.floor(Date.now() / 3600000) * 3600000) },
    });
  });
  afterAll(async () => {
    await prisma.adminAudit.deleteMany({
      where: { OR: [{ actorId: owner }, { details: { path: ["idempotencyKey"], string_starts_with: owner } }] },
    });
    await prisma.collectionTask.deleteMany({ where: { ownerId: owner } });
    await prisma.catalogSync.deleteMany({ where: { ownerId: owner } });
    await prisma.event.deleteMany({ where: { sourceExternalId: { startsWith: owner } } });
    await prisma.extractionJob.deleteMany({ where: { source: { externalId: { startsWith: owner } } } });
    await prisma.source.deleteMany({ where: { externalId: { startsWith: owner } } });
    await prisma.sourceRequestControl.deleteMany();
    await app?.close();
  });
  async function task(name: string, data: Record<string, unknown> = {}) {
    return prisma.collectionTask.create({
      data: { ownerId: owner, source, kind: "inspect", idempotencyKey: name, requestHash: name, payload: {}, ...data },
    });
  }
  it("atomically reserves the last request across competing executors", async () => {
    const reserve = () =>
      prisma.$queryRaw<Array<{ decision: string }>>`SELECT * FROM reserve_source_request(${source})`;
    const rows = (await Promise.all([reserve(), reserve()])).flat();
    expect(rows.map((r) => r.decision).sort()).toEqual(["allowed", "budget"]);
    expect(await prisma.sourceRequestControl.findUnique({ where: { source } })).toMatchObject({ requestCount: 1 });
    await expect(waitForSourceRequest(source)).rejects.toBeInstanceOf(SourceBudgetDeferred);
  });
  it.each(["ticketsports", "corridasbr"] as const)(
    "%s batch stops on budget or block without invalidating prior metadata",
    async (type) => {
      for (const [suffix, error] of [
        ["budget", new SourceBudgetDeferred(new Date(Date.now() + 3600000))],
        ["blocked", new ScraperHttpError("private upstream detail", "https://example.test/", 403)],
      ] as const) {
        let calls = 0;
        const id = owner + type + suffix;
        const row = {
          sourceType: type,
          adapter: type,
          externalId: id,
          name: "Source discovery",
          country: "BR" as const,
          state: "SC",
          city: "Teste",
          date: "2027-01-01",
          metadata: {},
          url:
            type === "ticketsports"
              ? "https://www.ticketsports.com.br/e/fixture-123"
              : "https://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=123",
        };
        const stored = await prisma.source.create({
          data: { name: row.name, url: row.url, adapter: type, externalId: id, type: "registration_page" },
        });
        await prisma.event.create({
          data: {
            id,
            slug: id,
            sourceId: stored.id,
            sourceType: type,
            sourceExternalId: id,
            sourceUrl: row.url,
            name: "Previous validated metadata",
            city: "Garuva",
            canonicalFingerprint: id,
            warnings: [],
            publishabilityReasons: [],
          },
        });
        const registry = new SourceAdapterRegistry({
          adapters: [
            {
              sourceType: type,
              adapter: type,
              adapterVersion: "fixture",
              canHandle: () => true,
              async fetchAndExtract() {
                calls++;
                throw error;
              },
            },
          ],
        });
        const discoverEvents = async () => [row, { ...row, externalId: id + "next" }];
        const result =
          type === "ticketsports"
            ? importTicketSportsEvents({
                registry,
                discoverEvents: discoverEvents as any,
                concurrency: 1,
                delayMs: 0,
                quantity: 2,
              })
            : importCorridasBREvents({
                registry,
                discoverEvents: discoverEvents as any,
                concurrency: 1,
                delayMs: 0,
                quantity: 2,
              });
        await expect(result).rejects.toThrow(suffix === "budget" ? "source_budget_wait" : "source_access_blocked");
        expect(calls).toBe(1);
        expect(await prisma.event.findUnique({ where: { id } })).toMatchObject({
          name: "Previous validated metadata",
          city: "Garuva",
        });
        const job = await prisma.extractionJob.findFirstOrThrow({ where: { sourceId: stored.id } });
        expect(job.status).toBe(suffix === "budget" ? "manual_review" : "provider_failed");
        if (suffix === "blocked")
          expect(
            (await prisma.sourceRequestControl.findUniqueOrThrow({ where: { source: type } })).blockedAt,
          ).not.toBeNull();
      }
    },
  );
  it.skipIf(!process.env.TEST_PYTHON)("Python observes the exact budget consumed by TypeScript", async () => {
    await waitForSourceRequest(source);
    const pythonUrl = new URL(process.env.DATABASE_URL!);
    pythonUrl.searchParams.delete("schema");
    const script = `import asyncio\nfrom worker import query\nfrom source_requests import database_request_hooks\nfrom app.services.source_requests import SourceBudgetDeferred\nasync def check():\n try: await database_request_hooks(query).before()\n except SourceBudgetDeferred: print('shared_budget_deferred'); return\n raise AssertionError('shared_budget_not_enforced')\nasyncio.run(check())`;
    const output = execFileSync(process.env.TEST_PYTHON!, ["-c", script], {
      cwd: resolve("apps/openresults-worker"),
      env: { ...process.env, WORKER_DATABASE_URL: pythonUrl.toString() },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(output.trim()).toBe("shared_budget_deferred");
  });
  it("renews an expired hourly window without removing a source block", async () => {
    await prisma.sourceRequestControl.update({
      where: { source },
      data: {
        requestCount: 1,
        windowStart: new Date(Date.now() - 7200000),
        nextAllowedAt: new Date(0),
      },
    });
    await waitForSourceRequest(source);
    expect(await prisma.sourceRequestControl.findUnique({ where: { source } })).toMatchObject({ requestCount: 1 });
    await blockSourceRequests(source);
    await expect(waitForSourceRequest(source)).rejects.toBeInstanceOf(SourceCircuitOpen);
  });
  it("defers without consuming attempts, keeps the checkpoint and fences an expired executor", async () => {
    const row = await task("defer", {
      status: "running",
      attempt: 2,
      leaseToken: "current",
      leaseUntil: new Date(Date.now() + 60000),
      payload: { checkpoint: 5 },
    });
    const error = new SourceBudgetDeferred(new Date(Date.now() + 3600000));
    expect(await deferSourceTask({ ...row, leaseToken: "old" }, { stage: "budget" }, error)).toBe(false);
    expect(await deferSourceTask(row, { stage: "budget" }, error)).toBe(true);
    expect(await prisma.collectionTask.findUnique({ where: { id: row.id } })).toMatchObject({
      status: "queued",
      attempt: 1,
      leaseToken: null,
      executionHold: false,
      errorCode: "source_budget_wait",
      payload: { checkpoint: 5 },
    });
  });
  it("holds queued work, skips new work, preserves prior holds and requires explicit audited resumption", async () => {
    const queued = await task("queued");
    const protectedTask = await task("protected", { executionHold: true, holdReason: "preexisting_protected_request" });
    const retryAt = new Date(Date.now() + 60000);
    await blockSourceRequests(source, retryAt);
    await blockSourceRequests(source); // Do not discard an already observed Retry-After.
    expect(await prisma.sourceRequestControl.findUnique({ where: { source } })).toMatchObject({
      blockedUntil: retryAt,
    });
    const future = await task("created-after-block");
    const claimed =
      await prisma.$queryRaw`SELECT * FROM claim_selected_task(ARRAY['openresults'],'lease',${[future.id]}::text[])`;
    expect(claimed).toEqual([]);
    await expect(resumeSourceRequests(source, owner, "Verified source", "resume-cooldown")).rejects.toThrow(
      "source_cooldown_active",
    );
    await prisma.sourceRequestControl.update({ where: { source }, data: { blockedUntil: new Date(0) } });
    await resumeSourceRequests(source, owner, "Verified source", "resume");
    expect(await prisma.collectionTask.findUnique({ where: { id: queued.id } })).toMatchObject({
      executionHold: false,
    });
    expect(await prisma.collectionTask.findUnique({ where: { id: protectedTask.id } })).toMatchObject({
      executionHold: true,
      holdReason: "preexisting_protected_request",
    });
    await blockSourceRequests(source);
    await resumeSourceRequests(source, owner, "Verified source", "resume");
    expect((await prisma.sourceRequestControl.findUniqueOrThrow({ where: { source } })).blockedAt).not.toBeNull();
    await expect(resumeSourceRequests(source, owner, "Different reason", "resume")).rejects.toThrow(
      "idempotency_conflict",
    );
    expect(await prisma.adminAudit.count({ where: { actorId: owner, action: "resume_source_requests" } })).toBe(1);
  });
  it("does not coordinate a discovery successor while a metadata request closed its source", async () => {
    const sync = await prisma.catalogSync.create({
      data: { ownerId: owner, source, options: { autoContinue: true }, cursor: 5 },
    });
    await task("step-completed", { kind: "catalog-sync", status: "completed", payload: { syncId: sync.id } });
    await blockSourceRequests(source);
    await coordinateCatalogSyncs();
    expect(
      await prisma.collectionTask.count({
        where: { ownerId: owner, status: "queued", payload: { path: ["syncId"], equals: sync.id } },
      }),
    ).toBe(0);
    expect(await prisma.catalogSync.findUnique({ where: { id: sync.id } })).toMatchObject({
      status: "ready",
      cursor: 5,
    });
  });
  it("authorizes administration, validates limits and preserves usage/blocks across idempotent configuration", async () => {
    const url = "/v1/admin/source-controls";
    expect((await app.inject({ url })).statusCode).toBe(401);
    const headers = { "x-api-key": "test-internal-key", "idempotency-key": owner + "api" };
    expect((await app.inject({ url, headers })).json().data).toHaveLength(3);
    await waitForSourceRequest(source);
    await blockSourceRequests(source);
    const path = url + "/openresults/configure";
    const payload = { limitPerHour: 2, minDelayMs: 2000, reason: "Controlled validation" };
    const first = await app.inject({ url: path, method: "POST", headers, payload });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ requestsUsed: 1, limitPerHour: 2 });
    expect(first.json().blockedAt).not.toBeNull();
    expect((await app.inject({ url: path, method: "POST", headers, payload })).json()).toEqual(first.json());
    expect(
      (await app.inject({ url: path, method: "POST", headers, payload: { ...payload, limitPerHour: 3 } })).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ url: path, method: "POST", headers, payload: { ...payload, limitPerHour: 101 } })).statusCode,
    ).toBe(400);
    expect(() => configureSourceRequests(source, owner, { ...payload, minDelayMs: 0 }, "unsafe")).toThrow(
      "source_request_limits_invalid",
    );
  });
  it("reports the next window rather than stale usage and dates", () => {
    const now = new Date("2026-10-01T15:20:00Z");
    expect(
      publicSourceControl(
        {
          source,
          windowStart: new Date("2026-10-01T12:00:00Z"),
          requestCount: 99,
          limitPerHour: 100,
          minDelayMs: 1000,
          blockedAt: null,
          blockedUntil: null,
          blockReason: null,
        },
        now,
      ),
    ).toMatchObject({
      requestsUsed: 0,
      resetAt: new Date("2026-10-01T16:00:00Z"),
    });
  });
});
