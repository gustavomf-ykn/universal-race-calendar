import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { prisma, saveCanonicalEvent, findCanonicalEventMatch, enqueueTask } from "@race-calendar/database";
import { runSourceCheck } from "@race-calendar/curation";
import type { CanonicalRaceEvent } from "@race-calendar/schemas";
import { buildApp } from "../apps/api/src/app.js";

const prefix = "edition-proof-" + randomUUID();
const events: string[] = [],
  sources: string[] = [],
  matches: string[] = [];
let seq = 0;
const identityBase = String(Date.now());
describe.skipIf(!process.env.DATABASE_URL)("edition matching and country evidence in isolated PostgreSQL", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    process.env.INTERNAL_API_KEY = "test-internal-key";
    app = await buildApp();
  });
  afterAll(async () => {
    await prisma.collectionTask.deleteMany({ where: { ownerId: prefix } });
    await prisma.workerPresence.deleteMany({ where: { version: prefix } });
    await prisma.adminAudit.deleteMany({ where: { eventId: { in: events } } });
    await prisma.sourceMatch.deleteMany({ where: { id: { in: matches } } });
    await prisma.curationJob.deleteMany({
      where: { OR: [{ eventId: { in: events } }, { rawSourceExtraction: { sourceId: { in: sources } } }] },
    });
    await prisma.extractionJob.deleteMany({ where: { sourceId: { in: sources } } });
    await prisma.rawSourceExtraction.deleteMany({ where: { sourceId: { in: sources } } });
    await prisma.resultSet.deleteMany({ where: { eventId: { in: events } } });
    await prisma.event.deleteMany({ where: { id: { in: events } } });
    await prisma.source.deleteMany({ where: { id: { in: sources } } });
    await app?.close();
  });
  async function canonical(type = "ticketsports", patch: Partial<CanonicalRaceEvent> = {}) {
    const externalId = identityBase + ++seq;
    const url =
      patch.sourceUrl ??
      (type === "ticketsports"
        ? `https://www.ticketsports.com.br/e/prova-${externalId}`
        : type === "openresults"
          ? `https://openresults.run/evento/${prefix}-${externalId}/`
          : `https://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=${externalId}`);
    const source = await prisma.source.create({
      data: { adapter: type, externalId, name: prefix, url, type: "registration_page" },
    });
    sources.push(source.id);
    return {
      name: prefix + externalId,
      slug: prefix + externalId,
      description: null,
      date: "2040-10-10",
      startTime: null,
      endTime: null,
      city: "São José",
      state: "SC",
      country: "BR",
      locationName: null,
      address: null,
      latitude: null,
      longitude: null,
      modality: "road",
      eventStatus: "scheduled",
      publicationStatus: "published",
      registrationUrl: null,
      officialUrl: null,
      regulationUrl: null,
      organizerName: null,
      organizerUrl: null,
      mainImageUrl: null,
      sourceId: source.id,
      sourceType: type,
      sourceExternalId: externalId,
      sourceUrl: url,
      confidence: 1,
      canonicalFingerprint: prefix + externalId,
      dedupeStatus: "unique",
      duplicateOfEventId: null,
      warnings: [],
      publishabilityReasons: [],
      distances: [],
      prices: [],
      kits: [],
      schedule: [],
      rules: [],
      kitPickup: null,
      images: [],
      ...patch,
    } as CanonicalRaceEvent;
  }
  async function save(value: CanonicalRaceEvent) {
    const result = await saveCanonicalEvent(value);
    if (!events.includes(result.event.id)) events.push(result.event.id);
    return result;
  }
  it("requires review even for an exact fingerprint and leaves both source identities intact", async () => {
    const a = await canonical();
    const first = await save(a);
    const b = await canonical("corridasbr", { canonicalFingerprint: a.canonicalFingerprint, name: a.name });
    expect(await findCanonicalEventMatch(b)).toMatchObject({ automatic: false, reason: "edition_fingerprint_review" });
    const second = await save(b);
    expect(second.event.id).not.toBe(first.event.id);
    expect(await prisma.event.findUnique({ where: { id: second.event.id } })).toMatchObject({
      publicationStatus: "pending_review",
      duplicateOfEventId: first.event.id,
      publishabilityReasons: expect.arrayContaining(["edition_fingerprint_review"]),
    });
  });
  it("does not link a shared organizer homepage or a spoofed provider host automatically", async () => {
    const a = await canonical("ticketsports", { officialUrl: "https://organizer.test/" });
    const first = await save(a);
    const b = await canonical("corridasbr", { officialUrl: a.officialUrl });
    expect(await findCanonicalEventMatch(b)).toMatchObject({
      event: { id: first.event.id },
      automatic: false,
      reason: "edition_link_unconfirmed",
    });
    const spoof = await canonical("corridasbr", {
      officialUrl: `https://www.ticketsports.com.br.attacker.test/e/prova-${a.sourceExternalId}`,
    });
    expect((await findCanonicalEventMatch(spoof))?.automatic ?? false).toBe(false);
  });
  it("links a unique verified edition reference and deduplicates its repeated refresh", async () => {
    const a = await canonical();
    const first = await save(a);
    const b = await canonical("corridasbr", {
      registrationUrl: `http://ticketsports.com.br/e/outro-slug-${a.sourceExternalId}?utm_source=test`,
      city: "sao jose",
    });
    expect(await findCanonicalEventMatch(b)).toMatchObject({ automatic: true, reason: "edition_link_confirmed" });
    expect((await save(b)).event.id).toBe(first.event.id);
    expect((await save(b)).event.id).toBe(first.event.id);
    expect(await prisma.eventSourceReference.count({ where: { eventId: first.event.id } })).toBe(2);
    expect(await prisma.event.findUnique({ where: { id: first.event.id } })).toMatchObject({
      sourceType: "ticketsports",
      name: a.name,
    });
  });
  it("recognizes a verified OpenResults edition link with canonical slash/host variants", async () => {
    const a = await canonical("openresults", { sourceUrl: `https://openresults.run/evento/${prefix}-linked/` });
    const first = await save(a);
    const b = await canonical("corridasbr", { officialUrl: `https://openresults.run/evento/${prefix}-linked` });
    expect(await findCanonicalEventMatch(b)).toMatchObject({ automatic: true, event: { id: first.event.id } });
    expect((await save(b)).event.id).toBe(first.event.id);
  });
  it("requires review for conflict, missing country, another provider ID or restricted edition", async () => {
    const a = await canonical();
    const first = await save(a);
    const b = await canonical("corridasbr", { registrationUrl: a.sourceUrl });
    expect(await findCanonicalEventMatch({ ...b, city: "Joinville" })).toMatchObject({
      automatic: false,
      reason: "edition_location_conflict",
    });
    expect(await findCanonicalEventMatch({ ...b, country: null })).toMatchObject({
      automatic: false,
      reason: "edition_location_unconfirmed",
    });
    const sameProvider = await canonical("ticketsports", { officialUrl: a.sourceUrl });
    expect(await findCanonicalEventMatch(sameProvider)).toMatchObject({
      automatic: false,
      reason: "edition_source_identity_conflict",
    });
    await prisma.event.update({
      where: { id: first.event.id },
      data: { publicationStatus: "hidden", administrativeReview: true },
    });
    expect(await findCanonicalEventMatch(b)).toMatchObject({
      automatic: false,
      reason: "edition_administratively_restricted",
    });
  });
  it("does not pick the first of conflicting direct edition links or mix annual editions", async () => {
    const a = await canonical();
    await save(a);
    const other = await canonical();
    await save(other);
    const b = await canonical("corridasbr", { registrationUrl: a.sourceUrl, officialUrl: other.sourceUrl });
    expect(await findCanonicalEventMatch(b)).toMatchObject({ automatic: false, reason: "edition_link_ambiguous" });
    expect(await findCanonicalEventMatch({ ...b, date: "2041-10-10" })).toBeNull();
    const newYear = await save({ ...b, date: "2041-10-10" });
    expect(newYear.duplicateOfEventId).toBeNull();
  });
  it("does not treat legacy populated location or conflicting observations as validated proof", async () => {
    const a = await canonical();
    const first = await save(a);
    const b = await canonical("corridasbr", { registrationUrl: a.sourceUrl });
    const reference = await prisma.eventSourceReference.findFirstOrThrow({ where: { eventId: first.event.id } });
    await prisma.eventSourceReference.update({
      where: { id: reference.id },
      data: { observation: {}, lastValidatedAt: null },
    });
    expect(await findCanonicalEventMatch(b)).toMatchObject({
      automatic: false,
      reason: "edition_observation_unconfirmed",
    });
    await prisma.eventSourceReference.update({
      where: { id: reference.id },
      data: {
        lastValidatedAt: new Date(),
        observation: { date: a.date, city: "Outra cidade", state: "SC", country: "BR" },
      },
    });
    expect((await findCanonicalEventMatch(b))?.automatic).toBe(false);
  });
  it("exposes observed country and registers unknown/foreign matches without defaulting to Brazil", async () => {
    for (const country of [null, "PT", "BR"]) {
      const id = prefix + "match-" + country;
      const match = await prisma.sourceMatch.create({
        data: {
          id,
          source: "openresults",
          externalId: id,
          url: `https://openresults.run/evento/${id}/`,
          name: prefix,
          date: new Date("2040-10-10"),
          city: "São José",
          state: "SC",
          country,
        },
      });
      matches.push(match.id);
      expect((await app.inject({ url: `/v1/admin/source-matches/${id}/register`, method: "POST" })).statusCode).toBe(
        401,
      );
      const headers = { "x-api-key": "test-internal-key" };
      const list = await app.inject({ url: "/v1/admin/source-matches?limit=100", headers });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().data.find((entry: { id: string }) => entry.id === id)?.country).toBe(country);
      const response = await app.inject({ url: `/v1/admin/source-matches/${id}/register`, method: "POST", headers });
      expect(response.statusCode, response.body).toBe(200);
      events.push(response.json().eventId);
      const event = await prisma.event.findUniqueOrThrow({ where: { id: response.json().eventId } });
      sources.push(event.sourceId!);
      expect(event).toMatchObject({ country, publicationStatus: "pending_review" });
      if (country === null) expect(event.publishabilityReasons).toContain("country_unconfirmed");
      const replay = await app.inject({ url: `/v1/admin/source-matches/${id}/register`, method: "POST", headers });
      expect(replay.json().eventId).toBe(event.id);
    }
  });
  it("rejects known location conflicts under lock and audits a manual association only once", async () => {
    const target = await save(await canonical());
    const id = prefix + "manual-match";
    const match = await prisma.sourceMatch.create({
      data: {
        id,
        source: "openresults",
        externalId: id,
        url: `https://openresults.run/evento/${id}/`,
        name: prefix,
        date: new Date("2040-10-10"),
        city: null,
        state: "SC",
        country: "PT",
      },
    });
    matches.push(match.id);
    const resolve = () =>
      app.inject({
        url: `/v1/admin/source-matches/${id}/resolve`,
        method: "POST",
        headers: { "x-api-key": "test-internal-key" },
        payload: { eventId: target.event.id },
      });
    expect((await resolve()).json()).toEqual({ error: "edition_location_conflict" });
    expect(
      await prisma.eventSourceReference.count({ where: { sourceType: "openresults", sourceExternalId: id } }),
    ).toBe(0);
    await prisma.sourceMatch.update({ where: { id }, data: { city: "São José", country: "BR" } });
    const [first, replay] = await Promise.all([resolve(), resolve()]);
    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    const source = await prisma.source.findUniqueOrThrow({
      where: { adapter_externalId: { adapter: "openresults", externalId: id } },
    });
    sources.push(source.id);
    expect(
      await prisma.eventSourceReference.count({ where: { sourceType: "openresults", sourceExternalId: id } }),
    ).toBe(1);
    expect(await prisma.adminAudit.count({ where: { eventId: target.event.id, action: "resolve_source_match" } })).toBe(
      1,
    );
  });
  it("registers the latest country after a concurrent inspection commits rather than an old snapshot", async () => {
    const id = prefix + "concurrent-country";
    await prisma.sourceMatch.create({
      data: {
        id,
        source: "openresults",
        externalId: id,
        url: `https://openresults.run/evento/${id}/`,
        name: prefix,
        date: new Date("2040-10-10"),
        country: "BR",
      },
    });
    matches.push(id);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const inspection = prisma.$transaction(
      async (tx) => {
        await tx.sourceMatch.update({ where: { id }, data: { country: "PT" } });
        locked();
        await gate;
      },
      { timeout: 15000 },
    );
    await ready;
    const request = app
      .inject({
        url: `/v1/admin/source-matches/${id}/register`,
        method: "POST",
        headers: { "x-api-key": "test-internal-key" },
      })
      .then((response) => response);
    let waiting = false;
    try {
      for (let i = 0; i < 100 && !waiting; i++) {
        const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SourceMatch%'
            AND pid<>pg_backend_pid()) AS waiting`;
        waiting = rows[0]?.waiting ?? false;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
      await inspection;
    }
    const response = await request;
    expect(response.statusCode, response.body).toBe(200);
    const event = await prisma.event.findUniqueOrThrow({ where: { id: response.json().eventId } });
    events.push(event.id);
    sources.push(event.sourceId!);
    expect(waiting).toBe(true);
    expect(event).toMatchObject({ country: "PT", publicationStatus: "pending_review" });
  });
  it("a real isolated executor stops at a reused annual identity, preserves results and records the safe cause", async () => {
    process.env.AI_PROVIDER = "mock";
    const text = (year: number) =>
      `Corrida Mock. Data 10/10/${year}. Florianopolis, SC, Brasil. Distancias 5 km. Inscricoes em https://example.test/inscricao.`;
    const source = await prisma.source.create({
      data: {
        name: prefix,
        url: "mock://" + prefix,
        type: "registration_page",
        adapter: "mock",
        externalId: prefix,
        country: "BR",
        state: "SC",
        city: "Florianopolis",
        metadata: { title: "Corrida Mock", importantText: text(2040) },
      },
    });
    sources.push(source.id);
    const initial = await runSourceCheck(source.id);
    expect(initial.status).toBe("success");
    events.push(initial.eventId!);
    const result = await prisma.resultSet.create({
      data: {
        eventId: initial.eventId!,
        source: "openresults",
        externalId: prefix,
        sourceUrl: "https://openresults.run/evento/fixture/",
        contentHash: "fixture",
        count: 1,
        results: { create: { recordKey: "synthetic", name: "Participante sintético", modality: "5k" } },
      },
    });
    await prisma.source.update({
      where: { id: source.id },
      data: { metadata: { title: "Corrida Mock", importantText: text(2041) } },
    });
    const task = await enqueueTask(prefix, prefix + "-annual-conflict", "maintenance", "check-source", {
      sourceId: source.id,
    });
    const folder = mkdtempSync(join(tmpdir(), "race-edition-worker-"));
    const selection = join(folder, "selection.json");
    writeFileSync(selection, JSON.stringify([task.id]));
    try {
      const output = execFileSync(process.execPath, ["apps/worker/dist/apps/worker/src/queue.js"], {
        windowsHide: true,
        timeout: 65000,
        encoding: "utf8",
        env: {
          ...process.env,
          AI_PROVIDER: "mock",
          WORKER_MODE: "batch",
          WORKER_MAX_TASKS: "1",
          WORKER_MAX_SECONDS: "60",
          WORKER_TASK_SELECTION_FILE: selection,
          WORKER_STOP_FILE: "",
          WORKER_REPORT_PATH: "",
          WORKER_CODE_VERSION: prefix,
          SUPABASE_URL: "",
          SUPABASE_SECRET_KEY: "",
          SUPABASE_SERVICE_ROLE_KEY: "",
        },
      });
      expect(output).toContain(`Calendar task ${task.id}: failed.`);
      expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
        status: "failed",
        attempt: 1,
        maxAttempts: 1,
        errorCode: "source_identifier_reused_for_different_edition",
      });
      expect(
        await prisma.extractionJob.findFirstOrThrow({ where: { sourceId: source.id }, orderBy: { createdAt: "desc" } }),
      ).toMatchObject({
        status: "validation_failed",
        errorMessage: "source_identifier_reused_for_different_edition",
        reasons: ["source_identifier_reused_for_different_edition"],
      });
      expect(await prisma.event.findUniqueOrThrow({ where: { id: initial.eventId! } })).toMatchObject({
        date: new Date("2040-10-10"),
      });
      expect(
        await prisma.resultSet.findUniqueOrThrow({ where: { id: result.id }, include: { results: true } }),
      ).toMatchObject({ count: 1, results: [{ recordKey: "synthetic" }] });
      expect(await prisma.workerPresence.findMany({ where: { version: prefix } })).toEqual(
        expect.arrayContaining([expect.objectContaining({ state: "stopped" })]),
      );
    } finally {
      unlinkSync(selection);
      rmdirSync(folder);
    }
  }, 90000);
});
