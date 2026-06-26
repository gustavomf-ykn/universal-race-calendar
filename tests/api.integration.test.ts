import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../apps/api/src/app.js";
import { prisma } from "@race-calendar/database";
import { importTicketSportsEvents } from "@race-calendar/curation";
import { SourceAdapterRegistry, TicketSportsAdapter } from "@race-calendar/sources";

const ticketsportsFixture = JSON.parse(readFileSync("tests/fixtures/ticketsports-simple.json", "utf-8")) as Record<
  string,
  unknown
>;
const ticketsportsListFixture = JSON.parse(readFileSync("tests/fixtures/ticketsports-list.json", "utf-8")) as Array<
  Record<string, unknown>
>;

describe.skipIf(!process.env.DATABASE_URL)("API integration", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let eventId: string;

  beforeAll(async () => {
    process.env.AI_PROVIDER = "mock";
    process.env.INTERNAL_API_KEY = "test-internal-key";
    app = await buildApp();
    await prisma.extractionJob.deleteMany();
    await prisma.rawSourceExtraction.deleteMany();
    await prisma.event.deleteMany();
    await prisma.source.deleteMany();
    await prisma.importRun.deleteMany();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("creates sources, checks them as jobs, exposes published events, skips unchanged content, and flags duplicates", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const invalidSource = await app.inject({
      method: "POST",
      url: "/v1/sources",
      headers: { "x-api-key": "test-internal-key" },
      payload: {
        name: "Fonte invalida",
        url: "not a url",
        type: "registration_page",
      },
    });
    expect(invalidSource.statusCode).toBe(400);

    const createdSource = await app.inject({
      method: "POST",
      url: "/v1/sources",
      headers: { "x-api-key": "test-internal-key" },
      payload: {
        name: "Meia Maratona Mock",
        url: "mock://meia-maratona-floripa",
        type: "registration_page",
        country: "BR",
        state: "SC",
        city: "Florianopolis",
        metadata: {
          title: "Meia Maratona de Florianopolis",
          importantText:
            "Meia Maratona de Florianopolis. Data 16/08/2026. Florianopolis, SC, Brasil. Distancias 5 km e 21 km. Inscricoes em https://example.test/inscricao.",
        },
      },
    });
    expect(createdSource.statusCode).toBe(201);
    const source = createdSource.json<{ id: string }>();

    const check = await app.inject({
      method: "POST",
      url: `/v1/sources/${source.id}/check`,
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(check.statusCode).toBe(200);
    const job = check.json<{ status: string; eventId: string }>();
    expect(job.status).toBe("success");
    eventId = job.eventId;

    const list = await app.inject({ method: "GET", url: "/v1/events?city=Florianopolis" });
    expect(list.statusCode).toBe(200);
    const listBody = list.json<{ data: Array<{ id: string; name: string; distances: string[] }> }>();
    expect(listBody.data[0]?.id).toBe(eventId);
    expect(listBody.data[0]?.distances).toContain("21 km");

    const detail = await app.inject({ method: "GET", url: `/v1/events/${eventId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ id: string }>().id).toBe(eventId);

    const unchanged = await app.inject({
      method: "POST",
      url: `/v1/sources/${source.id}/check`,
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json<{ eventId: string | null; reasons: string[] }>().eventId).toBeNull();
    expect(unchanged.json<{ reasons: string[] }>().reasons).toContain("unchanged_content");

    const duplicateSourceResponse = await app.inject({
      method: "POST",
      url: "/v1/sources",
      headers: { "x-api-key": "test-internal-key" },
      payload: {
        name: "Meia Maratona Mock Outra Fonte",
        url: "mock://meia-maratona-floripa-2",
        type: "registration_page",
        country: "BR",
        state: "SC",
        city: "Florianopolis",
        metadata: {
          title: "Meia Maratona de Florianopolis",
          importantText:
            "Meia Maratona de Florianopolis. Data 16/08/2026. Florianopolis, SC, Brasil. Distancias 5 km e 21 km. Inscricoes em https://example.test/inscricao.",
        },
      },
    });
    const duplicateSource = duplicateSourceResponse.json<{ id: string }>();
    const duplicateCheck = await app.inject({
      method: "POST",
      url: `/v1/sources/${duplicateSource.id}/check`,
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(duplicateCheck.statusCode).toBe(202);
    const duplicateJob = duplicateCheck.json<{ status: string; reasons: string[] }>();
    expect(duplicateJob.status).toBe("manual_review");
    expect(duplicateJob.reasons).toContain("possible_duplicate");
  });

  it("imports TicketSports street races and exposes them through the public API", async () => {
    await prisma.extractionJob.deleteMany();
    await prisma.rawSourceExtraction.deleteMany();
    await prisma.event.deleteMany();
    await prisma.source.deleteMany();
    await prisma.importRun.deleteMany();

    let detailPayload = ticketsportsFixture;
    const registry = new SourceAdapterRegistry({
      adapters: [
        new TicketSportsAdapter({
          async getJson() {
            return detailPayload;
          },
          async getText() {
            throw new Error("getText should not be called");
          },
        }),
      ],
    });
    const discoverEvents = async () =>
      ticketsportsListFixture.map((item) => ({
        sourceType: "ticketsports" as const,
        adapter: "ticketsports" as const,
        externalId: String(item.eventId),
        name: String(item.title),
        url: String(item.uri),
        country: "BR",
        state: "MG",
        city: "Uberaba",
        metadata: { listItem: item },
      }));

    const firstImport = await importTicketSportsEvents({
      quickFilter: "corrida-de-rua",
      quantity: 1,
      concurrency: 1,
      delayMs: 0,
      registry,
      discoverEvents,
    });
    expect(firstImport.status).toBe("success");
    expect(firstImport.requestedQuantity).toBe(1);
    expect(firstImport.offset).toBe(0);
    expect(firstImport.discoveredCount).toBe(1);
    expect(firstImport.publishedEvents).toBe(1);
    expect(await prisma.source.count({ where: { adapter: "ticketsports" } })).toBe(1);
    expect(await prisma.event.count({ where: { sourceType: "ticketsports", sourceExternalId: "74641" } })).toBe(1);

    const publicList = await app.inject({ method: "GET", url: "/v1/events?sourceType=ticketsports&limit=100" });
    expect(publicList.statusCode).toBe(200);
    const body = publicList.json<{ data: Array<{ name: string; sourceType?: string; registrationUrl: string }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.name).toBe("Meia Maratona de Florianopolis");
    expect(body.data[0]?.registrationUrl).toContain("ticketsports.com.br");

    const secondImport = await importTicketSportsEvents({
      quickFilter: "corrida-de-rua",
      quantity: 1,
      concurrency: 1,
      delayMs: 0,
      registry,
      discoverEvents,
    });
    expect(secondImport.unchangedEvents).toBe(1);
    expect(await prisma.source.count({ where: { adapter: "ticketsports" } })).toBe(1);
    expect(await prisma.event.count({ where: { sourceType: "ticketsports", sourceExternalId: "74641" } })).toBe(1);

    detailPayload = {
      ...ticketsportsFixture,
      title: "Meia Maratona de Florianopolis Atualizada",
      eventContents: [
        {
          title: "O Evento",
          description: "<p>Meia Maratona de Florianopolis atualizada com percursos de 5 km e 10 km.</p>",
        },
      ],
    };
    const updatedImport = await importTicketSportsEvents({
      quickFilter: "corrida-de-rua",
      quantity: 1,
      concurrency: 1,
      delayMs: 0,
      registry,
      discoverEvents,
    });
    expect(updatedImport.publishedEvents).toBe(1);
    expect(await prisma.event.count({ where: { sourceType: "ticketsports", sourceExternalId: "74641" } })).toBe(1);
    const updatedEvent = await prisma.event.findFirstOrThrow({
      where: { sourceType: "ticketsports", sourceExternalId: "74641" },
      include: { distances: true, versions: true },
    });
    expect(updatedEvent.name).toBe("Meia Maratona de Florianopolis Atualizada");
    expect(updatedEvent.distances.map((distance) => distance.label)).toContain("10 km");
    expect(updatedEvent.distances.map((distance) => distance.label)).not.toContain("21 km");
    expect(updatedEvent.versions).toHaveLength(2);

    const latestImport = await app.inject({
      method: "GET",
      url: "/v1/imports/ticketsports/latest",
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(latestImport.statusCode).toBe(200);
    expect(latestImport.json<{ source: string; processedCount: number; durationMs: number }>().source).toBe("ticketsports");
    expect(latestImport.json<{ processedCount: number }>().processedCount).toBe(1);
  });

  it("exposes the internal TicketSports import endpoint as a synchronous job", async () => {
    const fakeApp = await buildApp({
      importTicketSportsEvents: async () => ({
        jobId: "import_test",
        status: "success",
        source: "ticketsports",
        quickFilter: "corrida-de-rua",
        requestedQuantity: 1,
        offset: 0,
        discoveredCount: 1,
        processedCount: 1,
        publishedEvents: 1,
        manualReviewEvents: 0,
        unchangedEvents: 0,
        failedCount: 0,
        failures: [],
        startedAt: new Date("2026-06-23T00:00:00.000Z").toISOString(),
        finishedAt: new Date("2026-06-23T00:00:01.000Z").toISOString(),
      }),
    });
    const response = await fakeApp.inject({
      method: "POST",
      url: "/v1/imports/ticketsports/run",
      headers: { "x-api-key": "test-internal-key" },
      payload: { quantity: 1, delayMs: 0 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ jobId: string; publishedEvents: number }>().jobId).toBe("import_test");
    expect(response.json<{ publishedEvents: number }>().publishedEvents).toBe(1);
    await fakeApp.close();
  });

  it("lists review-pending events through the internal audit endpoint", async () => {
    const reviewList = await app.inject({
      method: "GET",
      url: "/v1/audit/events?publicationStatus=pending_review&limit=10",
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(reviewList.statusCode).toBe(200);
    expect(reviewList.json<{ data: unknown[]; pagination: { total: number } }>().data).toBeInstanceOf(Array);
  });

  it("supports admin event, curation job, and import run endpoints", async () => {
    const event = await prisma.event.findFirstOrThrow();

    const unauthorized = await app.inject({ method: "GET", url: "/v1/admin/events" });
    expect(unauthorized.statusCode).toBe(401);

    const adminList = await app.inject({
      method: "GET",
      url: "/v1/admin/events?sourceType=ticketsports&limit=10",
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json<{ data: unknown[]; pagination: { total: number } }>().data.length).toBeGreaterThan(0);

    const adminDetail = await app.inject({
      method: "GET",
      url: `/v1/admin/events/${event.id}`,
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(adminDetail.statusCode).toBe(200);
    expect(adminDetail.json<{ id: string; publicationStatus: string }>().id).toBe(event.id);

    const hide = await app.inject({
      method: "POST",
      url: `/v1/admin/events/${event.id}/hide`,
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(hide.statusCode).toBe(200);
    expect(hide.json<{ publicationStatus: string }>().publicationStatus).toBe("hidden");

    const publish = await app.inject({
      method: "POST",
      url: `/v1/admin/events/${event.id}/publish`,
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json<{ publicationStatus: string }>().publicationStatus).toBe("published");

    const dedupe = await app.inject({
      method: "PATCH",
      url: `/v1/admin/events/${event.id}/dedupe-status`,
      headers: { "x-api-key": "test-internal-key" },
      payload: { dedupeStatus: "needs_review" },
    });
    expect(dedupe.statusCode).toBe(200);
    expect(dedupe.json<{ dedupeStatus: string }>().dedupeStatus).toBe("needs_review");

    const jobs = await app.inject({
      method: "GET",
      url: "/v1/admin/curation/jobs?limit=10",
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json<{ data: unknown[]; pagination: { total: number } }>().data).toBeInstanceOf(Array);

    const imports = await app.inject({
      method: "GET",
      url: "/v1/admin/import-runs?source=ticketsports&limit=10",
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(imports.statusCode).toBe(200);
    expect(imports.json<{ data: unknown[]; pagination: { total: number } }>().data).toBeInstanceOf(Array);
  });
});
