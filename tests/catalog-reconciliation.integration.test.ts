import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  prisma,
  startCatalogReconciliation,
  processCatalogReconciliation,
  coordinateCatalogReconciliations,
  controlCatalogReconciliation,
  claimTask,
  finishTask,
  resolveEventId,
} from "@race-calendar/database";
import { buildApp } from "../apps/api/src/app.js";

const owner = "global-reconcile-" + randomUUID();
const events: string[] = [],
  sourceIds: string[] = [];
let seq = 0;
describe.skipIf(!process.env.DATABASE_URL)("durable reconciliation of the three source catalogs", () => {
  beforeAll(() => {
    const uri = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "postgres"].includes(uri.hostname) || !uri.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
  });
  afterEach(async () => {
    const runs = await prisma.catalogReconciliation.findMany({ where: { ownerId: owner }, select: { id: true } });
    await prisma.catalogReconciliationDecision.deleteMany({ where: { runId: { in: runs.map((row) => row.id) } } });
    await prisma.catalogReconciliation.deleteMany({ where: { ownerId: owner } });
    await prisma.adminAudit.deleteMany({ where: { actorId: owner } });
    await prisma.collectionTask.deleteMany({ where: { ownerId: owner } });
    await prisma.resultSet.deleteMany({ where: { eventId: { in: events } } });
    await prisma.eventAlias.deleteMany({ where: { OR: [{ createdBy: owner }, { canonicalEventId: { in: events } }] } });
    await prisma.event.deleteMany({ where: { id: { in: events } } });
    await prisma.source.deleteMany({ where: { id: { in: sourceIds } } });
    events.length = 0;
    sourceIds.length = 0;
  });
  async function edition(type: string, link?: string) {
    const ordinal = ++seq,
      id = owner + "-" + ordinal,
      externalId = String(Date.now()) + ordinal;
    const url =
      type === "ticketsports"
        ? `https://www.ticketsports.com.br/e/prova-${externalId}`
        : type === "corridasbr"
          ? `https://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=${externalId}`
          : `https://openresults.run/evento/${id}`;
    const source = await prisma.source.create({
      data: { name: owner, url, adapter: type, externalId, type: "official_page" },
    });
    sourceIds.push(source.id);
    events.push(id);
    const observation = { name: "Prova controlada", date: "2040-10-10", city: "São José", state: "SC", country: "BR" };
    return prisma.event.create({
      data: {
        id,
        slug: id,
        ...observation,
        date: new Date("2040-10-10"),
        sourceId: source.id,
        sourceType: type,
        sourceExternalId: externalId,
        sourceUrl: url,
        registrationUrl: link,
        publicationStatus: "pending_review",
        canonicalFingerprint: id,
        warnings: [],
        publishabilityReasons: [],
        createdAt: new Date(new Date("2020-01-01T00:00:00Z").getTime() + ordinal),
        sourceReferences: {
          create: {
            sourceId: source.id,
            sourceType: type,
            sourceExternalId: externalId,
            url,
            observation,
            lastValidatedAt: new Date(),
            role: "primary",
          },
        },
      },
    });
  }
  async function start(key = randomUUID()) {
    const result = await startCatalogReconciliation(owner, key, "Teste controlado de cruzamento");
    const task = await claimTask(["maintenance"]);
    expect(task?.id).toBe(result.taskId);
    // A historical snapshot isolates this controlled catalog from persistent
    // fixtures created by other integration suites in the same disposable DB.
    const isolated = await prisma.catalogReconciliation.update({
      where: { id: result.run.id },
      data: { snapshotAt: new Date("2020-01-02T00:00:00Z") },
    });
    return { ...result, run: { ...result.run, snapshotAt: isolated.snapshotAt }, task: task! };
  }
  it("unifies a verified three-source group, preserves results and records one atomic receipt", async () => {
    const ts = await edition("ticketsports"),
      cb = await edition("corridasbr", ts.sourceUrl!),
      or = await edition("openresults", ts.sourceUrl!);
    const results = await prisma.resultSet.create({
      data: {
        eventId: or.id,
        source: "openresults",
        externalId: or.sourceExternalId!,
        sourceUrl: or.sourceUrl!,
        contentHash: "synthetic-preservation-fixture",
        count: 1,
      },
    });
    const athlete = await prisma.raceResult.create({
      data: {
        resultSetId: results.id,
        recordKey: "synthetic-row",
        name: "Participante sintético",
        modality: "5 km",
        time: "00:25:00",
      },
    });
    const { run, task } = await start();
    const progress = await processCatalogReconciliation(task);
    expect(progress).toMatchObject({ stage: "completed", scanned: 1, merged: 2 });
    expect(await prisma.event.count({ where: { id: { in: [ts.id, cb.id, or.id] } } })).toBe(1);
    expect(await resolveEventId(cb.id)).toBe(ts.id);
    expect(await resolveEventId(or.id)).toBe(ts.id);
    expect((await prisma.resultSet.findUniqueOrThrow({ where: { id: results.id } })).eventId).toBe(ts.id);
    expect(await prisma.raceResult.findUniqueOrThrow({ where: { id: athlete.id } })).toEqual(athlete);
    expect(await prisma.adminAudit.count({ where: { actorId: owner, action: "reconcile_events" } })).toBe(2);
    expect(await prisma.catalogReconciliationDecision.count({ where: { runId: run.id, status: "merged" } })).toBe(1);
    expect(await processCatalogReconciliation(task)).toEqual(progress);
  });
  it("follows a transitive component when its oldest destination is not directly linked to every member", async () => {
    const or = await edition("openresults"),
      ts = await edition("ticketsports"),
      cb = await edition("corridasbr", ts.sourceUrl!);
    await prisma.event.update({ where: { id: or.id }, data: { registrationUrl: cb.sourceUrl } });
    const { task } = await start();
    expect(await processCatalogReconciliation(task)).toMatchObject({ stage: "completed", merged: 2 });
    expect(await resolveEventId(ts.id)).toBe(or.id);
    expect(await resolveEventId(cb.id)).toBe(or.id);
  });
  it.each(["date", "country", "sourceIdentity", "observation"])(
    "retains the entire group for review on %s conflict",
    async (variant) => {
      const ts = await edition("ticketsports"),
        cb = await edition("corridasbr", ts.sourceUrl!);
      const other = await edition(variant === "sourceIdentity" ? "corridasbr" : "openresults", ts.sourceUrl!);
      if (variant === "date")
        await prisma.event.update({ where: { id: other.id }, data: { date: new Date("2041-10-10") } });
      if (variant === "country") await prisma.event.update({ where: { id: other.id }, data: { country: null } });
      if (variant === "observation")
        await prisma.eventSourceReference.updateMany({ where: { eventId: cb.id }, data: { observation: {} } });
      const { task } = await start();
      expect(await processCatalogReconciliation(task)).toMatchObject({ stage: "completed_with_review", merged: 0 });
      expect(await prisma.event.count({ where: { id: { in: events } } })).toBe(3);
      expect(await prisma.eventAlias.count({ where: { createdBy: owner } })).toBe(0);
    },
  );
  it("does not merge a generic homepage or fingerprint and ignores events created after its snapshot", async () => {
    const ts = await edition("ticketsports", "https://organizer.example/"),
      cb = await edition("corridasbr", "https://organizer.example/");
    await prisma.event.update({ where: { id: cb.id }, data: { canonicalFingerprint: ts.canonicalFingerprint } });
    const { run, task } = await start();
    const future = await edition("openresults", ts.sourceUrl!);
    await prisma.event.update({
      where: { id: future.id },
      data: { createdAt: new Date(new Date(run.snapshotAt).getTime() + 1000) },
    });
    expect(await processCatalogReconciliation(task)).toMatchObject({
      stage: "completed_with_review",
      scanned: 2,
      merged: 0,
    });
    expect(await prisma.event.count({ where: { id: { in: events } } })).toBe(3);
  });
  it("continues a bounded step once across competing coordinators and refuses an expired executor", async () => {
    await edition("ticketsports");
    await edition("corridasbr");
    const { run, task } = await start();
    const first = await processCatalogReconciliation(task, 1);
    expect(first.scanned).toBe(1);
    expect(first.stage).toBe("reconciliation_continuation");
    expect(await finishTask(task, "completed", first)).toBe(true);
    expect(
      (await Promise.all([coordinateCatalogReconciliations(), coordinateCatalogReconciliations()])).reduce(
        (a, b) => a + b,
      ),
    ).toBe(1);
    const next = (await claimTask(["maintenance"]))!;
    await expect(processCatalogReconciliation(task)).rejects.toThrow("lease_lost");
    await prisma.collectionTask.update({ where: { id: next.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const recovered = (await claimTask(["maintenance"]))!;
    expect(recovered.id).toBe(next.id);
    await expect(processCatalogReconciliation(next)).rejects.toThrow("lease_lost");
    expect(await processCatalogReconciliation(recovered)).toMatchObject({ stage: "completed", scanned: 2 });
    expect(await prisma.catalogReconciliationDecision.count({ where: { runId: run.id } })).toBe(2);
  });
  it("waits for an active result task without advancing its cursor or losing valid data", async () => {
    const ts = await edition("ticketsports"),
      or = await edition("openresults", ts.sourceUrl!);
    const active = await prisma.collectionTask.create({
      data: {
        ownerId: owner,
        idempotencyKey: randomUUID(),
        requestHash: "fixture",
        source: "openresults",
        kind: "extract",
        payload: { eventId: or.id },
        status: "running",
        leaseToken: "fixture",
        leaseUntil: new Date(Date.now() + 90000),
      },
    });
    const { run, task } = await start();
    expect(await processCatalogReconciliation(task)).toMatchObject({ stage: "waiting", scanned: 0, merged: 0 });
    expect((await prisma.catalogReconciliation.findUniqueOrThrow({ where: { id: run.id } })).cursorEventId).toBeNull();
    await prisma.collectionTask.update({ where: { id: active.id }, data: { status: "completed" } });
    expect(await processCatalogReconciliation(task)).toMatchObject({ stage: "completed", scanned: 1, merged: 1 });
    expect(await prisma.catalogReconciliationDecision.count({ where: { runId: run.id, status: "waiting" } })).toBe(0);
  });
  it("pauses only this scan and resumes its checkpoint with idempotent audit", async () => {
    await edition("ticketsports");
    await edition("corridasbr");
    const { run, task } = await start();
    const progress = await processCatalogReconciliation(task, 1);
    await finishTask(task, "completed", progress);
    await controlCatalogReconciliation(owner, "pause-test", run.id, "pause");
    expect(await coordinateCatalogReconciliations()).toBe(0);
    expect((await controlCatalogReconciliation(owner, "resume-test", run.id, "resume")).status).toBe("ready");
    await controlCatalogReconciliation(owner, "resume-test", run.id, "resume");
    const next = (await claimTask(["maintenance"]))!;
    expect(await processCatalogReconciliation(next)).toMatchObject({ stage: "completed", scanned: 2 });
    expect(await prisma.adminAudit.count({ where: { actorId: owner, action: "catalog_reconciliation_control" } })).toBe(
      2,
    );
  });
  it("serializes starts and preserves replay without creating competing or orphaned tasks", async () => {
    const starts = await Promise.allSettled([
      startCatalogReconciliation(owner, "concurrent-a", "Primeira varredura"),
      startCatalogReconciliation(owner, "concurrent-b", "Segunda varredura"),
    ]);
    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = starts.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.message).toBe("catalog_reconciliation_active");
    expect(await prisma.collectionTask.count({ where: { ownerId: owner } })).toBe(1);
    const first = (
      starts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<typeof startCatalogReconciliation>>
      >
    ).value;
    const task = await prisma.collectionTask.findUniqueOrThrow({ where: { id: first.taskId } });
    const reason = (task.payload as { reason: string }).reason;
    expect((await startCatalogReconciliation(owner, task.idempotencyKey, reason)).taskId).toBe(first.taskId);
    await expect(startCatalogReconciliation(owner, task.idempotencyKey, "Outro motivo")).rejects.toThrow(
      "idempotency_conflict",
    );
    await controlCatalogReconciliation(owner, "pause-concurrent", first.run.id, "pause");
    await expect(startCatalogReconciliation(owner, "third", "Outra varredura")).rejects.toThrow(
      "catalog_reconciliation_active",
    );
  });
  it("exposes explicit admin-only scan, replay, paging and controls through the real API contract", async () => {
    const app = await buildApp();
    let accepted: { run: { id: string }; taskId: string } | undefined;
    try {
      const path = "/v1/admin/catalog/reconciliations/scans",
        key = "scan-http",
        body = { reason: "Teste do contrato" };
      expect((await app.inject({ method: "POST", url: path, payload: body })).statusCode).toBe(401);
      const admin = { "x-api-key": process.env.INTERNAL_API_KEY!, "idempotency-key": key };
      // Internal administrative identity belongs to this request, and is cleaned explicitly below.
      const first = await app.inject({ method: "POST", url: path, headers: admin, payload: body });
      expect(first.statusCode).toBe(202);
      const scan = first.json();
      accepted = scan;
      const example = await edition("ticketsports");
      await prisma.catalogReconciliationDecision.create({
        data: { runId: scan.run.id, eventId: example.id, status: "review", reason: "edition_link_unconfirmed" },
      });
      expect((await app.inject({ method: "POST", url: path, headers: admin, payload: body })).json().taskId).toBe(
        scan.taskId,
      );
      expect(
        (await app.inject({ method: "POST", url: path, headers: admin, payload: { reason: "Outra intenção" } }))
          .statusCode,
      ).toBe(409);
      expect(
        (await app.inject({ method: "GET", url: path + "/" + scan.run.id + "?limit=1&page=1", headers: admin })).json(),
      ).toMatchObject({
        total: 1,
        page: 1,
        limit: 1,
        run: { id: scan.run.id, status: "ready", latestTask: { id: scan.taskId, status: "queued" } },
        data: [
          { eventId: example.id, candidates: [{ id: example.id, name: example.name, sourceType: "ticketsports" }] },
        ],
      });
      const safe = (await app.inject({ method: "GET", url: path, headers: admin })).json();
      expect(JSON.stringify(safe)).not.toContain("leaseToken");
      expect(JSON.stringify(safe)).not.toContain("idempotencyKey");
      const paused = await app.inject({ method: "POST", url: path + "/" + scan.run.id + "/pause", headers: admin });
      expect(paused.json()).not.toHaveProperty("error");
      expect(paused.statusCode).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: path + "/" + scan.run.id + "/unknown", headers: admin })).statusCode,
      ).toBe(400);
      const openapi = (await app.inject({ method: "GET", url: "/v1/openapi.json" })).json();
      const parameters = openapi.paths[path + "/{id}/{action}"].post.parameters;
      expect(parameters.find((parameter: { name: string }) => parameter.name === "action").schema.enum).toEqual([
        "pause",
        "resume",
        "cancel",
      ]);
    } finally {
      if (accepted) {
        await prisma.catalogReconciliationDecision.deleteMany({ where: { runId: accepted.run.id } });
        await prisma.catalogReconciliation.deleteMany({ where: { id: accepted.run.id } });
        await prisma.adminAudit.deleteMany({
          where: { OR: [{ taskId: accepted.taskId }, { details: { path: ["runId"], equals: accepted.run.id } }] },
        });
        await prisma.collectionTask.deleteMany({ where: { id: accepted.taskId } });
      }
      await app.close();
    }
  });
  it("preserves confirmed checkpoints on failure, cancels only pending scan work and permits a deliberate new scan", async () => {
    await edition("ticketsports");
    await edition("corridasbr");
    const { run, task } = await start();
    const progress = await processCatalogReconciliation(task, 1);
    await expect(controlCatalogReconciliation(owner, "cancel-running", run.id, "cancel")).rejects.toThrow(
      "catalog_reconciliation_in_use",
    );
    await prisma.collectionTask.update({ where: { id: task.id }, data: { maxAttempts: 1 } });
    await finishTask(task, "failed", progress, "controlled_failure");
    await coordinateCatalogReconciliations();
    expect((await prisma.catalogReconciliation.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("blocked");
    await controlCatalogReconciliation(owner, "resume-failed", run.id, "resume");
    const pending = await prisma.collectionTask.findFirstOrThrow({ where: { ownerId: owner, status: "queued" } });
    expect((pending.payload as { checkpointSequence: number }).checkpointSequence).toBe(1);
    const unrelated = await prisma.collectionTask.create({
      data: {
        ownerId: owner,
        idempotencyKey: "unrelated",
        requestHash: "fixture",
        source: "openresults",
        kind: "inspect",
        payload: {},
      },
    });
    await controlCatalogReconciliation(owner, "cancel-pending", run.id, "cancel");
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("cancelled");
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: unrelated.id } })).status).toBe("queued");
    expect(await prisma.catalogReconciliationDecision.count({ where: { runId: run.id } })).toBe(1);
    expect((await controlCatalogReconciliation(owner, "cancel-pending", run.id, "cancel")).status).toBe("cancelled");
    expect(await coordinateCatalogReconciliations()).toBe(0);
    const fresh = await startCatalogReconciliation(owner, "explicit-new-scan", "Nova varredura intencional");
    expect(fresh.run.id).not.toBe(run.id);
    expect(fresh.run.scannedCount).toBe(0);
  });
  it("protects reconciliation tables with RLS and no public API role privileges", async () => {
    const tables = await prisma.$queryRaw<
      Array<{ name: string; rls: boolean }>
    >`SELECT relname AS name,relrowsecurity AS rls FROM pg_class
      WHERE relname IN ('CatalogReconciliation','CatalogReconciliationDecision')`;
    expect(tables).toHaveLength(2);
    expect(tables.every((table) => table.rls)).toBe(true);
    const grants = await prisma.$queryRaw<
      Array<{ grantee: string }>
    >`SELECT grantee FROM information_schema.role_table_grants
      WHERE table_name IN ('CatalogReconciliation','CatalogReconciliationDecision') AND grantee IN ('PUBLIC','anon','authenticated')`;
    expect(grants).toEqual([]);
    const privateRun = await startCatalogReconciliation(owner, "private-scan", "Privacidade do cruzamento");
    await prisma.catalogReconciliationDecision.create({
      data: { runId: privateRun.run.id, eventId: "synthetic-private-receipt", status: "unmatched" },
    });
    await prisma.$executeRawUnsafe(
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='test_catalog_scan_reader') THEN CREATE ROLE test_catalog_scan_reader; END IF; END $$",
    );
    await prisma.$executeRawUnsafe("GRANT USAGE ON SCHEMA public TO test_catalog_scan_reader");
    await prisma.$executeRawUnsafe(
      'GRANT SELECT ON "CatalogReconciliation","CatalogReconciliationDecision" TO test_catalog_scan_reader',
    );
    const visible = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE test_catalog_scan_reader");
      return {
        runs: await tx.$queryRaw<unknown[]>`SELECT id FROM "CatalogReconciliation"`,
        decisions: await tx.$queryRaw<unknown[]>`SELECT id FROM "CatalogReconciliationDecision"`,
      };
    });
    expect(visible).toEqual({ runs: [], decisions: [] });
  });
  it("processes only the selected scan in the actual TypeScript executor and preserves unrelated queued work", async () => {
    const ts = await edition("ticketsports"),
      cb = await edition("corridasbr", ts.sourceUrl!);
    const scan = await startCatalogReconciliation(owner, "actual-worker", "Executor TypeScript controlado");
    await prisma.catalogReconciliation.update({
      where: { id: scan.run.id },
      data: { snapshotAt: new Date("2020-01-02T00:00:00Z") },
    });
    const unrelated = await prisma.collectionTask.create({
      data: {
        ownerId: owner,
        idempotencyKey: "protected-fixture",
        requestHash: "fixture",
        source: "maintenance",
        kind: "unused",
        payload: {},
      },
    });
    const directory = await mkdtemp(join(tmpdir(), "race-reconciliation-worker-"));
    const selection = join(directory, "selection.json"),
      report = join(directory, "report.json");
    await writeFile(selection, JSON.stringify([scan.taskId]));
    try {
      const code = await new Promise<number | null>((done, failed) => {
        const child = spawn(process.execPath, [resolve("apps/worker/dist/apps/worker/src/queue.js")], {
          cwd: process.cwd(),
          stdio: "ignore",
          env: {
            ...process.env,
            WORKER_MODE: "batch",
            WORKER_MAX_TASKS: "1",
            WORKER_MAX_SECONDS: "45",
            WORKER_TASK_SELECTION_FILE: selection,
            WORKER_REPORT_PATH: report,
            WORKER_STOP_FILE: "",
          },
        });
        const timeout = setTimeout(() => child.kill(), 50000);
        child.once("error", (error) => {
          clearTimeout(timeout);
          failed(error);
        });
        child.once("exit", (value) => {
          clearTimeout(timeout);
          done(value);
        });
      });
      expect(code).toBe(0);
      expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
        claimed: 1,
        tasks: [{ id: scan.taskId, status: "completed" }],
      });
      expect((await prisma.catalogReconciliation.findUniqueOrThrow({ where: { id: scan.run.id } })).status).toBe(
        "completed",
      );
      expect(await resolveEventId(cb.id)).toBe(ts.id);
      expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: unrelated.id } })).status).toBe("queued");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
  it("fences its task before waiting for the edition gate so recovery cannot invert lock order", async () => {
    await edition("ticketsports");
    const { task } = await start();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('race_event_reconciliation',0))`;
        entered();
        await gate;
      },
      { timeout: 25000 },
    );
    await ready;
    const processing = processCatalogReconciliation(task);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS(SELECT FROM pg_stat_activity
          WHERE wait_event='advisory' AND query LIKE '%race_event_reconciliation%') AS present`;
        if (rows[0]?.present) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(waiting).toBe(true);
      const recoverable = await prisma.$transaction(
        (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "CollectionTask"
        WHERE id=${task.id} FOR UPDATE SKIP LOCKED`,
      );
      expect(recoverable).toEqual([]);
    } finally {
      release();
      await holder;
      await processing;
    }
  });
});
