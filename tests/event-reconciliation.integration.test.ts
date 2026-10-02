import { randomUUID, createHash } from "node:crypto";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { generateEventFingerprint } from "@race-calendar/utils";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { buildApp } from "../apps/api/src/app.js";
import {
  prisma,
  previewEventReconciliation,
  reconcileEventEditions,
  resolveEventId,
  resolveEventIds,
  resolveEventSlug,
  enqueueTask,
  readResultCheckpoint,
} from "@race-calendar/database";

const prefix = "reconcile-" + randomUUID();
const ids: string[] = [],
  sources: string[] = [];
let sequence = 0;
describe.skipIf(!process.env.DATABASE_URL)("transactional reconciliation of separate editions", () => {
  beforeAll(() => {
    const uri = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "postgres"].includes(uri.hostname) || !uri.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
  });
  afterEach(async () => {
    // Acquisition serializes each source: do not leave the running synthetic fixture
    // from one case occupying the source slot for the next concurrency case.
    await prisma.collectionTask.updateMany({
      where: { ownerId: prefix, status: "running" },
      data: { status: "cancelled", leaseToken: null, leaseUntil: null },
    });
  });
  afterAll(async () => {
    await prisma.resultCheckpoint.deleteMany({ where: { eventId: { in: ids } } });
    await prisma.eventAlias.deleteMany({ where: { OR: [{ createdBy: prefix }, { canonicalEventId: { in: ids } }] } });
    const ownedTasks = await prisma.collectionTask.findMany({
      where: { idempotencyKey: { startsWith: prefix } },
      select: { id: true },
    });
    await prisma.exportArtifact.deleteMany({
      where: { OR: [{ ownerId: prefix }, { taskId: { in: ownedTasks.map((task) => task.id) } }] },
    });
    await prisma.collectionTask.deleteMany({
      where: { OR: [{ ownerId: prefix }, { idempotencyKey: { startsWith: prefix } }] },
    });
    await prisma.adminAudit.deleteMany({ where: { OR: [{ actorId: prefix }, { eventId: { in: ids } }] } });
    await prisma.apiCredential.deleteMany({ where: { name: prefix } });
    await prisma.sourceMatch.deleteMany({ where: { eventId: { in: ids } } });
    await prisma.curationJob.deleteMany({ where: { eventId: { in: ids } } });
    await prisma.extractionJob.deleteMany({ where: { sourceId: { in: sources } } });
    await prisma.resultSet.deleteMany({ where: { eventId: { in: ids } } });
    await prisma.event.deleteMany({ where: { id: { in: ids } } });
    await prisma.source.deleteMany({ where: { id: { in: sources } } });
  });
  async function edition(type: string, registrationUrl?: string) {
    const id = prefix + "-" + ++sequence,
      externalId = String(Date.now()) + sequence;
    const url =
      type === "ticketsports"
        ? `https://www.ticketsports.com.br/e/known-${externalId}`
        : type === "corridasbr"
          ? `https://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=${externalId}`
          : `https://openresults.run/evento/${id}/`;
    const source = await prisma.source.create({
      data: { id: id + "-source", name: prefix, url, adapter: type, externalId, type: "official_page" },
    });
    sources.push(source.id);
    ids.push(id);
    const observation = {
      name: prefix,
      date: "2040-10-10",
      city: "São José",
      state: "SC",
      country: "BR",
      registrationUrl: registrationUrl ?? null,
      sourceUrl: url,
    };
    return prisma.event.create({
      data: {
        id,
        slug: id,
        name: prefix,
        date: new Date("2040-10-10"),
        city: "São José",
        state: "SC",
        country: "BR",
        sourceId: source.id,
        sourceType: type,
        sourceExternalId: externalId,
        sourceUrl: url,
        registrationUrl: registrationUrl ?? null,
        canonicalFingerprint: id,
        warnings: [],
        publishabilityReasons: [],
        publicationStatus: "published",
        modality: "road",
        confidence: 0.95,
        sourceReferences: {
          create: {
            sourceId: source.id,
            sourceType: type,
            sourceExternalId: externalId,
            url,
            role: "primary",
            priority: type === "ticketsports" ? 100 : type === "corridasbr" ? 50 : 10,
            observation,
            lastValidatedAt: new Date(),
          },
        },
      },
    });
  }
  async function pair() {
    const target = await edition("ticketsports");
    const source = await edition("openresults", target.sourceUrl!);
    return { source, target };
  }
  const request = (sourceId: string, targetId: string, revision: string) => ({
    sourceId,
    targetId,
    revision,
    reason: "Correspondência comprovada nas referências de edição",
    confirmedSameEdition: true,
    mode: "automatic" as const,
  });
  async function consumer(mode: string, sourceId: string, targetId: string, taskId: string) {
    return new Promise<void>((ok, fail) => {
      const child = spawn(
        process.env.TEST_PYTHON ?? "python",
        ["-m", "tests.fixture_reconciliation", mode, sourceId, targetId, taskId],
        {
          cwd: resolve("apps/openresults-worker"),
          env: { ...process.env, WORKER_DATABASE_URL: process.env.DATABASE_URL!.split("?")[0]! },
        },
      );
      let diagnostic = "";
      child.stderr.on("data", (data) => {
        diagnostic += String(data);
      });
      child.on("error", fail);
      child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(diagnostic))));
    });
  }

  it("atomically preserves results, files, checkpoints and historical relations with one audit for concurrent replay", async () => {
    const { source, target } = await pair();
    await prisma.event.update({ where: { id: source.id }, data: { description: "Descrição revisada" } });
    const distance = await prisma.eventDistance.create({ data: { eventId: source.id, label: "5 km", distanceKm: 5 } });
    const version = await prisma.eventVersion.create({
      data: {
        eventId: source.id,
        schemaVersion: "fixture",
        curationVersion: "fixture",
        snapshot: { originalEventId: source.id },
      },
    });
    const extraction = await prisma.extractionJob.create({
      data: { eventId: source.id, sourceId: source.sourceId!, status: "success" },
    });
    const curation = await prisma.curationJob.create({
      data: {
        eventId: source.id,
        provider: "mock",
        model: "mock",
        contentHash: "fixture",
        schemaVersion: "fixture",
        curationVersion: "fixture",
        status: "success",
      },
    });
    const results = await prisma.resultSet.create({
      data: {
        eventId: source.id,
        source: "openresults",
        externalId: source.sourceExternalId!,
        sourceUrl: source.sourceUrl!,
        contentHash: "old-validated",
        count: 1,
        results: { create: { recordKey: "synthetic", name: "Participante sintético", modality: "5k" } },
      },
    });
    const task = await enqueueTask(prefix, source.id + "-extract", "openresults", "extract", {
      eventId: source.id,
      externalId: source.sourceExternalId!,
      url: source.sourceUrl!,
    });
    const artifactTask = await enqueueTask(prefix, source.id + "-export", "exports", "export", { eventId: source.id });
    const artifact = await prisma.exportArtifact.create({
      data: {
        eventId: source.id,
        ownerId: prefix,
        taskId: artifactTask.id,
        selection: { eventIds: [source.id] },
        status: "completed",
        objectPath: "synthetic/existing.xlsx",
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await prisma.resultCheckpoint.create({
      data: {
        rootTaskId: task.id,
        activeTaskId: task.id,
        eventId: source.id,
        externalId: source.sourceExternalId!,
        sourceUrl: source.sourceUrl!,
        parserVersion: 2,
        pageSize: 100,
        manifestHash: "fixture",
        manifest: {},
        status: "ready",
      },
    });
    const match = await prisma.sourceMatch.create({
      data: {
        source: "openresults",
        externalId: source.sourceExternalId!,
        url: source.sourceUrl!,
        name: prefix,
        eventId: source.id,
        status: "resolved",
        resolvedBy: prefix,
      },
    });
    await prisma.adminAudit.create({
      data: {
        actorId: prefix,
        eventId: source.id,
        action: "review_event",
        details: { changes: { description: "Descrição revisada" } },
      },
    });
    const preview = await previewEventReconciliation(source.id, target.id);
    expect(preview).toMatchObject({ canMerge: true, automatic: true, reasons: [] });
    const input = request(source.id, target.id, preview.revision);
    const [a, b] = await Promise.all([
      reconcileEventEditions(prefix, source.id, input),
      reconcileEventEditions(prefix, source.id, input),
    ]);
    expect(a).toEqual(b);
    expect(await prisma.event.findUnique({ where: { id: source.id } })).toBeNull();
    expect(await prisma.event.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      description: "Descrição revisada",
      sourceType: "ticketsports",
      canonicalFingerprint: generateEventFingerprint({ ...target, date: "2040-10-10" }),
    });
    for (const row of [
      await prisma.eventDistance.findUniqueOrThrow({ where: { id: distance.id } }),
      await prisma.eventVersion.findUniqueOrThrow({ where: { id: version.id } }),
      await prisma.extractionJob.findUniqueOrThrow({ where: { id: extraction.id } }),
      await prisma.curationJob.findUniqueOrThrow({ where: { id: curation.id } }),
      await prisma.sourceMatch.findUniqueOrThrow({ where: { id: match.id } }),
    ])
      expect(row.eventId).toBe(target.id);
    expect(await prisma.resultSet.findUniqueOrThrow({ where: { id: results.id } })).toMatchObject({
      eventId: target.id,
      contentHash: "old-validated",
      count: 1,
    });
    expect(await prisma.raceResult.count({ where: { resultSetId: results.id } })).toBe(1);
    expect(await prisma.exportArtifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({
      eventId: target.id,
      objectPath: "synthetic/existing.xlsx",
      status: "completed",
      selection: { eventIds: [source.id] },
    });
    expect(await prisma.resultCheckpoint.findUniqueOrThrow({ where: { rootTaskId: task.id } })).toMatchObject({
      eventId: target.id,
      status: "ready",
    });
    expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: "queued",
      requestHash: task.requestHash,
      payload: task.payload,
    });
    expect(await resolveEventId(source.id)).toBe(target.id);
    expect(await resolveEventIds([source.id, target.id, source.id])).toEqual([target.id]);
    expect(await resolveEventSlug(source.slug)).toBe(target.id);
    expect(
      await prisma.adminAudit.count({ where: { actorId: prefix, action: "reconcile_events", eventId: target.id } }),
    ).toBe(1);
    expect((await prisma.eventAlias.findUniqueOrThrow({ where: { id: source.id } })).snapshot).toMatchObject({
      id: source.id,
      distances: [{ id: distance.id }],
      resultSets: [{ id: results.id }],
    });
    await expect(
      prisma.event.create({
        data: {
          id: source.id,
          slug: source.slug,
          name: prefix,
          canonicalFingerprint: source.id,
          warnings: [],
          publishabilityReasons: [],
        },
      }),
    ).rejects.toThrow(/event_alias_identity_reserved/);
    await expect(reconcileEventEditions(prefix, source.id, { ...input, reason: "Payload distinto" })).rejects.toThrow(
      "idempotency_conflict",
    );
    expect(await readResultCheckpoint(task)).toMatchObject({ reason: "result_checkpoint_in_use" });
    await consumer("read", source.id, target.id, task.id);
    const [claimed] = await prisma.$queryRaw<
      Array<{ id: string }>
    >`SELECT * FROM claim_selected_task(ARRAY['openresults'],${randomUUID()},${[task.id]}::text[])`;
    expect(claimed?.id).toBe(task.id);
    await consumer("publish", source.id, target.id, task.id);
    expect(await prisma.resultSet.findUniqueOrThrow({ where: { id: results.id } })).toMatchObject({
      eventId: target.id,
      count: 1,
    });
    expect(await prisma.raceDiscipline.count({ where: { resultSetId: results.id } })).toBe(1);
  });

  it("serves old links and retains collection/export idempotency across a union", async () => {
    const { source, target } = await pair();
    await prisma.resultSet.create({
      data: {
        eventId: source.id,
        source: "openresults",
        externalId: source.sourceExternalId!,
        sourceUrl: source.sourceUrl!,
        contentHash: "reference",
        count: 1,
        results: { create: { recordKey: "fixture", name: "Participante sintético", modality: "5k" } },
        disciplines: { create: { externalId: "5k", name: "5 km" } },
      },
    });
    const app = await buildApp();
    const admin = { "x-api-key": "test-internal-key" };
    const collectionKey = source.id + "api-collection",
      exportKey = source.id + "api-export";
    try {
      const collect = () =>
        app.inject({
          method: "POST",
          url: "/v1/collections",
          headers: { ...admin, "idempotency-key": collectionKey },
          payload: { source: "openresults", eventId: source.id },
        });
      const exported = () =>
        app.inject({
          method: "POST",
          url: `/v1/events/${source.id}/exports`,
          headers: { ...admin, "idempotency-key": exportKey },
        });
      const firstCollect = await collect(),
        firstExport = await exported();
      expect(firstCollect.statusCode).toBe(202);
      expect(firstExport.statusCode).toBe(202);
      const preview = await previewEventReconciliation(source.id, target.id);
      await reconcileEventEditions(prefix, source.id + "api-merge", request(source.id, target.id, preview.revision));
      for (const url of [
        `/v1/events/${source.id}`,
        `/v1/events/slug/${source.slug}`,
        `/v1/admin/events/${source.id}`,
      ]) {
        const response = await app.inject({ url, headers: admin });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().id).toBe(target.id);
      }
      const modalities = await app.inject({ url: `/v1/events/${source.id}/modalities` });
      expect(modalities.statusCode).toBe(200);
      expect(modalities.json().data).toHaveLength(1);
      const results = await app.inject({ url: `/v1/events/${source.id}/results?modality=5k&limit=1`, headers: admin });
      expect(results.statusCode).toBe(200);
      expect(results.json().pagination.total).toBe(1);
      const againCollect = await collect(),
        againExport = await exported();
      expect(againCollect.statusCode).toBe(202);
      expect(againCollect.json().id).toBe(firstCollect.json().id);
      expect(againExport.statusCode).toBe(202);
      expect(againExport.json().taskId).toBe(firstExport.json().taskId);
      expect(await prisma.collectionTask.count({ where: { idempotencyKey: { in: [collectionKey, exportKey] } } })).toBe(
        2,
      );
      const selection = await app.inject({
        method: "POST",
        url: "/v1/exports",
        headers: { ...admin, "idempotency-key": source.id + "selection" },
        payload: { kind: "results", layout: "consolidated", eventIds: [source.id, target.id] },
      });
      expect(selection.statusCode, selection.body).toBe(202);
      const file = await prisma.exportArtifact.findUniqueOrThrow({ where: { id: selection.json().id } });
      expect(file.selection).toMatchObject({ eventIds: [target.id] });
      await prisma.exportArtifact.deleteMany({
        where: { taskId: { in: [firstCollect.json().id, firstExport.json().taskId] } },
      });
      await prisma.exportArtifact.delete({ where: { id: file.id } });
      await prisma.collectionTask.deleteMany({
        where: { idempotencyKey: { in: [collectionKey, exportKey, source.id + "selection"] } },
      });
    } finally {
      await app.close();
    }
  });

  it("requires admin, a current preview and confirmation, and hides aliases when the canonical edition is hidden", async () => {
    const { source, target } = await pair();
    await prisma.apiCredential.create({
      data: {
        name: prefix,
        keyHash: createHash("sha256").update(prefix).digest("hex"),
        scopes: ["results:read", "exports:write", "tasks:read"],
      },
    });
    const app = await buildApp(),
      route = "/v1/admin/catalog/reconciliations";
    const admin = { "x-api-key": "test-internal-key" },
      input = { sourceId: source.id, targetId: target.id };
    try {
      expect((await app.inject({ method: "POST", url: route + "/preview", payload: input })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: route + "/preview",
            headers: { "x-client-key": prefix },
            payload: input,
          })
        ).statusCode,
      ).toBe(403);
      const preview = await app.inject({ method: "POST", url: route + "/preview", headers: admin, payload: input });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().automatic).toBe(true);
      const payload = {
        ...input,
        revision: preview.json().revision,
        reason: "Mesma edição comprovada nas fontes",
        confirmedSameEdition: true,
      };
      const headers = { ...admin, "idempotency-key": source.id + "route" };
      expect((await app.inject({ method: "POST", url: route, headers: admin, payload })).statusCode).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: route,
            headers,
            payload: { ...payload, confirmedSameEdition: false },
          })
        ).statusCode,
      ).toBe(400);
      await prisma.event.update({ where: { id: source.id }, data: { description: "Alteração após preview" } });
      const stale = await app.inject({ method: "POST", url: route, headers, payload });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe("reconciliation_preview_stale");
      const current = await app.inject({ method: "POST", url: route + "/preview", headers: admin, payload: input });
      payload.revision = current.json().revision;
      const merged = await app.inject({ method: "POST", url: route, headers, payload });
      expect(merged.statusCode, merged.body).toBe(200);
      expect(merged.json().eventId).toBe(target.id);
      const replay = await app.inject({ method: "POST", url: route, headers, payload });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(merged.json());
      await app.inject({
        method: "PATCH",
        url: `/v1/admin/catalog/events/${source.id}`,
        headers: admin,
        payload: { publicationStatus: "hidden", reason: "Ocultação administrativa de teste" },
      });
      for (const url of [
        `/v1/events/${source.id}`,
        `/v1/events/slug/${source.slug}`,
        `/v1/events/${source.id}/results`,
      ])
        expect((await app.inject({ url, headers: admin })).statusCode).toBe(404);
      expect(await prisma.adminAudit.count({ where: { eventId: target.id, action: "reconcile_events" } })).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("rejects changed year/location/manual decisions and obsolete previews without mutating either edition", async () => {
    const { source, target } = await pair();
    const original = await previewEventReconciliation(source.id, target.id);
    await prisma.event.update({ where: { id: source.id }, data: { date: new Date("2041-10-10") } });
    expect((await previewEventReconciliation(source.id, target.id)).reasons).toContain("edition_date_mismatch");
    await expect(
      reconcileEventEditions(prefix, source.id + "stale", request(source.id, target.id, original.revision)),
    ).rejects.toThrow("reconciliation_preview_stale");
    await prisma.event.update({ where: { id: source.id }, data: { date: target.date, country: "PT" } });
    expect((await previewEventReconciliation(source.id, target.id)).reasons).toContain("edition_location_conflict");
    await prisma.event.update({ where: { id: source.id }, data: { country: "BR", publicationStatus: "hidden" } });
    expect((await previewEventReconciliation(source.id, target.id)).reasons).toContain(
      "edition_administratively_restricted",
    );
    await prisma.event.update({
      where: { id: source.id },
      data: { publicationStatus: "published", name: "Nome revisado da origem" },
    });
    for (const eventId of [source.id, target.id])
      await prisma.adminAudit.create({
        data: {
          actorId: prefix,
          eventId,
          action: "review_event",
          details: { changes: { name: "Revisão administrativa" } },
        },
      });
    const conflict = await previewEventReconciliation(source.id, target.id);
    expect(conflict.reasons).toContain("edition_manual_conflict");
    await expect(
      reconcileEventEditions(prefix, source.id + "manual", request(source.id, target.id, conflict.revision)),
    ).rejects.toThrow("edition_manual_conflict");
    expect(await prisma.event.count({ where: { id: { in: [source.id, target.id] } } })).toBe(2);
    expect(await prisma.eventAlias.count({ where: { id: source.id } })).toBe(0);
  });

  it("requires an explicit manual decision without direct proof and flattens subsequent aliases", async () => {
    const target = await edition("ticketsports"),
      source = await edition("openresults");
    const preview = await previewEventReconciliation(source.id, target.id);
    expect(preview).toMatchObject({ canMerge: true, automatic: false, automaticReason: "edition_link_unconfirmed" });
    await expect(
      reconcileEventEditions(prefix, source.id + "auto", request(source.id, target.id, preview.revision)),
    ).rejects.toThrow("edition_link_unconfirmed");
    await expect(
      reconcileEventEditions(prefix, source.id + "confirm", {
        ...request(source.id, target.id, preview.revision),
        mode: "manual",
        confirmedSameEdition: false,
      }),
    ).rejects.toThrow("edition_confirmation_required");
    await reconcileEventEditions(prefix, source.id + "manual", {
      ...request(source.id, target.id, preview.revision),
      mode: "manual",
    });
    const third = await edition("corridasbr", target.sourceUrl!);
    const next = await previewEventReconciliation(target.id, third.id);
    await reconcileEventEditions(prefix, source.id + "second", {
      ...request(target.id, third.id, next.revision),
      mode: "manual",
    });
    expect(await resolveEventId(source.id)).toBe(third.id);
    expect(await resolveEventId(target.id)).toBe(third.id);
    expect(await resolveEventSlug(source.slug)).toBe(third.id);
    expect(await prisma.event.findUniqueOrThrow({ where: { id: third.id } })).toMatchObject({
      sourceType: "ticketsports",
      sourceExternalId: target.sourceExternalId,
    });
    expect(await prisma.eventSourceReference.count({ where: { eventId: third.id } })).toBe(3);
    expect(await prisma.eventSourceReference.count({ where: { eventId: third.id, role: "primary" } })).toBe(1);
    expect(
      await prisma.eventSourceReference.findFirstOrThrow({ where: { eventId: third.id, role: "primary" } }),
    ).toMatchObject({ sourceType: "ticketsports" });
  });

  it("requires review when a second recognized edition link points to another canonical record", async () => {
    const { source, target } = await pair();
    const other = await edition("corridasbr");
    await prisma.event.update({ where: { id: source.id }, data: { officialUrl: other.sourceUrl } });
    const preview = await previewEventReconciliation(source.id, target.id);
    expect(preview).toMatchObject({ automatic: false, automaticReason: "edition_link_ambiguous" });
    await expect(
      reconcileEventEditions(prefix, source.id + "ambiguous", request(source.id, target.id, preview.revision)),
    ).rejects.toThrow("edition_link_ambiguous");
    expect(await prisma.event.count({ where: { id: { in: [source.id, target.id, other.id] } } })).toBe(3);
  });

  it("blocks a running executor even with an expired lease", async () => {
    const { source, target } = await pair();
    const task = await enqueueTask(prefix, source.id + "active", "openresults", "extract", { eventId: source.id });
    await prisma.collectionTask.update({
      where: { id: task.id },
      data: { status: "running", leaseToken: "fixture", leaseUntil: new Date(Date.now() - 1000) },
    });
    const preview = await previewEventReconciliation(source.id, target.id);
    expect(preview).toMatchObject({
      canMerge: false,
      reasons: ["edition_reconciliation_in_use"],
      runningTasks: [{ id: task.id }],
    });
    await expect(
      reconcileEventEditions(prefix, source.id + "active", request(source.id, target.id, preview.revision)),
    ).rejects.toThrow("edition_reconciliation_in_use");
    expect(await prisma.eventSourceReference.findFirstOrThrow({ where: { sourceId: source.sourceId! } })).toMatchObject(
      { eventId: source.id },
    );
  });

  it("also blocks an active provider batch whose payload cannot enumerate the editions it may update", async () => {
    const { source, target } = await pair();
    const task = await enqueueTask(prefix, source.id + "calendar", "ticketsports", "calendar", { quantity: 5 });
    await prisma.collectionTask.update({
      where: { id: task.id },
      data: { status: "running", leaseToken: "synthetic", leaseUntil: new Date(Date.now() + 90000) },
    });
    const preview = await previewEventReconciliation(source.id, target.id);
    expect(preview).toMatchObject({
      canMerge: false,
      reasons: ["edition_reconciliation_in_use"],
      runningTasks: [{ id: task.id }],
    });
    expect(await prisma.event.count({ where: { id: { in: [source.id, target.id] } } })).toBe(2);
  });

  it("preserves an explicit legacy publication decision and selects one primary reference even without a legacy primary", async () => {
    const { source, target } = await pair();
    await prisma.event.update({ where: { id: source.id }, data: { publicationStatus: "draft" } });
    await prisma.adminAudit.create({
      data: {
        eventId: source.id,
        actorId: prefix,
        action: "publication_status",
        details: { before: "published", after: "draft" },
      },
    });
    await prisma.event.update({
      where: { id: target.id },
      data: { sourceType: null, sourceExternalId: null, sourceId: null, sourceUrl: null },
    });
    const preview = await previewEventReconciliation(source.id, target.id);
    await reconcileEventEditions(prefix, source.id + "legacy", {
      ...request(source.id, target.id, preview.revision),
      mode: "manual",
    });
    expect(await prisma.event.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      publicationStatus: "draft",
      sourceType: "ticketsports",
      sourceExternalId: target.sourceExternalId,
    });
    expect(await prisma.eventSourceReference.count({ where: { eventId: target.id, role: "primary" } })).toBe(1);
  });

  it("serializes a union queued before acquisition and resolves the alias after the gate opens", async () => {
    const { source, target } = await pair();
    const task = await enqueueTask(prefix, source.id + "race-claim", "openresults", "extract", { eventId: source.id });
    const preview = await previewEventReconciliation(source.id, target.id);
    let acquired!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('race_event_reconciliation',0))`;
        acquired();
        await gate;
      },
      { timeout: 15000 },
    );
    await ready;
    const union = reconcileEventEditions(
      prefix,
      source.id + "race-union",
      request(source.id, target.id, preview.revision),
    );
    const waitingFor = async (pattern: string) => {
      for (let i = 0; i < 100; i++) {
        const [state] = await prisma.$queryRaw<
          Array<{ waiting: boolean }>
        >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE ${pattern} AND pid<>pg_backend_pid()) AS waiting`;
        if (state?.waiting) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };
    let claim: Promise<Array<{ id: string; payload: object }>> | undefined;
    try {
      expect(await waitingFor("%race_event_reconciliation%")).toBe(true);
      claim = prisma.$queryRaw<
        Array<{ id: string; payload: object }>
      >`SELECT * FROM claim_selected_task(ARRAY['openresults'],${randomUUID()},${[task.id]}::text[])`.then(
        (rows) => rows,
      );
      expect(await waitingFor("%claim_selected_task%")).toBe(true);
    } finally {
      release();
      await holder;
    }
    expect(await union).toMatchObject({ eventId: target.id, sourceId: source.id });
    expect(await claim).toMatchObject([{ id: task.id, payload: { eventId: source.id } }]);
    expect(await resolveEventId(source.id)).toBe(target.id);
  });

  it("a claim waits for the canonical row lock after a union and retains its original payload", async () => {
    const { source, target } = await pair();
    const task = await enqueueTask(prefix, source.id + "claim", "openresults", "extract", { eventId: source.id });
    const preview = await previewEventReconciliation(source.id, target.id);
    await reconcileEventEditions(prefix, source.id + "merge", request(source.id, target.id, preview.revision));
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
        locked = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Event" WHERE id=${target.id} FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 15000 },
    );
    await ready;
    const pending = prisma.$queryRaw<
      Array<{ id: string; payload: object }>
    >`SELECT * FROM claim_selected_task(ARRAY['openresults'],${randomUUID()},${[task.id]}::text[])`.then(
      (value) => value,
    );
    let waiting = false;
    try {
      for (let i = 0; i < 100 && !waiting; i++) {
        const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%claim_selected_task%' AND pid<>pg_backend_pid()) AS waiting`;
        waiting = rows[0]?.waiting ?? false;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
      await holder;
    }
    expect(waiting).toBe(true);
    expect(await pending).toMatchObject([{ id: task.id, payload: { eventId: source.id } }]);
    expect(await resolveEventId(source.id)).toBe(target.id);
  });
});
