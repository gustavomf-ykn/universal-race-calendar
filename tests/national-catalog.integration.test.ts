import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, setTaskLease, heartbeatTask } from "@race-calendar/database";
import { syncNationalTicketSports, nationalSnapshot } from "../apps/worker/src/national-catalog.js";
import { syncNationalCorridasBR } from "../apps/worker/src/corridas-catalog.js";
import type { TicketSportsCatalogPage } from "@race-calendar/sources";

const enabled = Boolean(process.env.DATABASE_URL);
const prefix = "national-test-" + randomUUID();
describe.skipIf(!enabled)("national prefix checkpoint on isolated PostgreSQL", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
  });
  afterAll(async () => {
    if (!enabled) return;
    const events = await prisma.event.findMany({ where: { sourceExternalId: { startsWith: prefix } } });
    await prisma.adminAudit.deleteMany({ where: { eventId: { in: events.map(e => e.id) } } });
    await prisma.event.deleteMany({ where: { id: { in: events.map(e => e.id) } } });
    await prisma.source.deleteMany({ where: { externalId: { startsWith: prefix } } });
    await prisma.collectionTask.deleteMany({ where: { ownerId: prefix } });
    await prisma.catalogSync.deleteMany({ where: { ownerId: prefix } });
  });
  const page = (quantity: number, total: number): TicketSportsCatalogPage => {
    const events = Array.from({ length: Math.min(quantity, total) }, (_, i) => ({
      sourceType: "ticketsports" as const, adapter: "ticketsports" as const, externalId: prefix + i,
      name: "Corrida", url: `https://www.ticketsports.com.br/e/test-${i}`, city: "Garuva", state: "SC",
      country: "BR", date: "2026-10-01", metadata: {},
    }));
    return { requested: quantity, rawCount: events.length, rawIds: events.map(e => e.externalId),
      invalidCount: 0, excludedCountryCount: 0, excludedCountryIds: [], unknownCountryCount: 0,
      events, terminal: events.length < quantity };
  };
  async function fixture(id: string, states: string[], source = "ticketsports") {
    const sync = await prisma.catalogSync.create({ data: { id: prefix + id, ownerId: prefix, source,
      options: { discoveryMode: "national", states, batchSize: 5, prefixLimit: 10000 } } });
    const task = await prisma.collectionTask.create({ data: { ownerId: prefix, idempotencyKey: id,
      requestHash: id, source, kind: "catalog-sync", payload: { syncId: sync.id }, status: "running",
      leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) } });
    return { sync, task };
  }
  it("expands beyond the first prefix, enriches once per reference and resumes without skipping candidates", async () => {
    const { sync, task } = await fixture("expand", ["SC"]);
    setTaskLease(task);
    const quantities: number[] = [];
    const discover = async ({ quantity }: { quantity: number }) => { quantities.push(quantity); return page(quantity, 26); };
    for (let i = 0; i < 8; i++) {
      expect(await heartbeatTask(task, { stage: "test_catalog_step" })).toBe(true);
      const current = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
      await syncNationalTicketSports(current, discover);
    }
    const final = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    expect(quantities).toEqual([25, 50, 25, 50]);
    expect(final).toMatchObject({ status: "completed", discovered: 26, processed: 26, cursor: 0 });
    expect(await prisma.event.count({ where: { sourceExternalId: { startsWith: prefix } } })).toBe(26);
    expect(await prisma.collectionTask.count({ where: { ownerId: prefix, kind: "check-source" } })).toBe(26);
    const before = quantities.length;
    await syncNationalTicketSports(final, discover);
    expect(quantities.length).toBe(before);
    expect((final.snapshot as { receipts: unknown[] }).receipts).toHaveLength(2);
  }, 90000);
  it("follows the explicit next CorridasBR calendar once, resumes and deduplicates a link back", async () => {
    const { sync, task } = await fixture("corridas-pages", ["SC"], "corridasbr");
    setTaskLease(task);
    const firstUrl = "https://www.corridasbr.com.br/sc/calendario.asp";
    const secondUrl = "https://www.corridasbr.com.br/sc/calendario2.asp";
    const candidate = (n: number) => ({ sourceType: "corridasbr" as const, adapter: "corridasbr" as const,
      externalId: prefix + "corridas-" + n, name: "Corrida", url: `https://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=${n}`,
      city: "Garuva", state: "SC", country: null, date: "2026-10-01", metadata: {} });
    await syncNationalCorridasBR(sync, async () => ({ url: firstUrl, nextUrls: [secondUrl], events: [candidate(1)] }));
    const resumed = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    expect(resumed.status).toBe("ready");
    await syncNationalCorridasBR(resumed, async ({ url }) => {
      expect(url).toBe(secondUrl);
      return { url: secondUrl, nextUrls: [firstUrl], events: [candidate(1), candidate(2)] };
    });
    const final = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    expect(final).toMatchObject({ status: "completed", discovered: 2, processed: 2 });
    expect((final.snapshot as { receipts: unknown[] }).receipts).toEqual([{
      state: "SC", status: "completed", reason: "explicit_calendar_navigation_end", requested: 2, rawCount: 3, unique: 2,
      scope: "source_partition", unknownCountry: 2, outOfScope: 0,
    }]);
    expect(await prisma.collectionTask.count({ where: { ownerId: prefix, source: "corridasbr", kind: "check-source" } })).toBe(2);
  });
  it("reconciles a nationwide record without UF without repeating the state reference", async () => {
    const { sync, task } = await fixture("nationwide", ["SC"]);
    setTaskLease(task);
    const regional = page(25, 1);
    await syncNationalTicketSports(sync, async () => regional);
    const current = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    const extra = { ...regional.events[0]!, externalId: prefix + "unknown-uf", state: null };
    await syncNationalTicketSports(current, async options => {
      expect(options.state).toBeUndefined();
      return { ...regional, events: [...regional.events, extra], rawCount: 2,
        rawIds: [...regional.rawIds, extra.externalId], terminal: true };
    });
    const final = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    expect(final).toMatchObject({ status: "completed", discovered: 2, processed: 2 });
    expect((final.snapshot as { receipts: Array<{ state: string }> }).receipts.map(r => r.state)).toEqual(["SC", "BR"]);
    const pending = await prisma.event.findUniqueOrThrow({ where: {
      sourceType_sourceExternalId: { sourceType: "ticketsports", sourceExternalId: extra.externalId } } });
    expect(pending).toMatchObject({ state: null, publicationStatus: "pending_review" });
  });
  it("records a truly empty UF then advances; a region mismatch cannot be marked complete", async () => {
    const { sync, task } = await fixture("states", ["AC", "SC"]);
    setTaskLease(task);
    await syncNationalTicketSports(sync, async ({ quantity }) => page(quantity, 0));
    const current = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    expect(current).toMatchObject({ page: 2, status: "ready" });
    expect((current.snapshot as { receipts: Array<{ state: string }> }).receipts[0]?.state).toBe("AC");
    await expect(syncNationalTicketSports(current, async ({ quantity }) => ({ ...page(quantity, 1),
      events: page(quantity, 1).events.map(e => ({ ...e, state: "SP" })) }))).rejects.toThrow("catalog_region_ignored");
    expect((await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } })).status).toBe("ready");
  });
  it("fences a stale executor before storing its discovered snapshot", async () => {
    const { sync, task } = await fixture("lease", ["SC"]);
    setTaskLease(task);
    await prisma.collectionTask.update({ where: { id: task.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    await expect(syncNationalTicketSports(sync, async ({ quantity }) => page(quantity, 1))).rejects.toThrow("lease_lost");
    expect((await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } })).discovered).toBe(0);
  });
  it("retains unknown-country candidates, deduplicates coverage receipts and never invents BR", async () => {
    const { sync, task } = await fixture("unknown-country", ["SC"]);
    setTaskLease(task);
    const regional = page(25, 1);
    const unknown = { ...regional.events[0]!, externalId: prefix + "unknown-country", country: null };
    const response = { ...regional, events: [unknown], unknownCountryCount: 1,
      excludedCountryIds: [prefix + "foreign"], excludedCountryCount: 1,
      rawIds: [unknown.externalId, prefix + "foreign"], rawCount: 2 };
    await syncNationalTicketSports(sync, async () => response);
    const resumed = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    await syncNationalTicketSports(resumed, async () => response);
    const final = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    expect(final).toMatchObject({ status: "completed", discovered: 1, processed: 1 });
    expect((final.snapshot as { receipts: unknown[] }).receipts).toEqual([
      expect.objectContaining({ state: "SC", scope: "source_partition", unique: 2, unknownCountry: 1, outOfScope: 1 }),
      expect.objectContaining({ state: "BR", scope: "source_partition", unique: 2, unknownCountry: 1, outOfScope: 1 }),
    ]);
    expect(await prisma.event.findUniqueOrThrow({ where: { sourceType_sourceExternalId: {
      sourceType: "ticketsports", sourceExternalId: unknown.externalId } } })).toMatchObject({
        country: null, state: "SC", publicationStatus: "pending_review", warnings: ["country_unconfirmed"],
        publishabilityReasons: ["metadata_validation_required", "country_unconfirmed"],
      });
    expect(await prisma.collectionTask.count({ where: { ownerId: prefix, kind: "check-source",
      payload: { path: ["syncId"], equals: sync.id } } })).toBe(1);
  });
  it("refuses old checkpoints whose countries may have been presumed", () => {
    expect(() => nationalSnapshot({ nationalVersion: 1, candidates: [], seenIds: [], receipts: [] }))
      .toThrow("catalog_checkpoint_incompatible");
  });
  it("records unknown and foreign CorridasBR countries before period filters, resets receipts per UF and enriches once", async () => {
    const { sync, task } = await fixture("corridas-country", ["SC", "ES"], "corridasbr");
    const scopedSync = await prisma.catalogSync.update({ where: { id: sync.id }, data: {
      options: { ...(sync.options as object), from: "2026-10-01" } } });
    setTaskLease(task);
    const candidate = (id: string, state: string, country: string | null) => ({
      sourceType: "corridasbr" as const, adapter: "corridasbr" as const, externalId: prefix + id,
      name: "Corrida", url: `https://www.corridasbr.com.br/${state}/mostracorrida.asp?escolha=1`,
      city: "Cidade", state, country, date: "2026-10-01", metadata: {},
    });
    const unknown = candidate("corridas-unknown", "SC", null), foreign = candidate("corridas-foreign", "SC", "PT");
    const old = { ...candidate("corridas-before-period", "SC", null), date: "2020-01-01" };
    const firstUrl = "https://www.corridasbr.com.br/sc/calendario.asp";
    const secondUrl = "https://www.corridasbr.com.br/sc/calendario2.asp";
    await syncNationalCorridasBR(scopedSync, async () => ({ url: firstUrl, nextUrls: [secondUrl], events: [unknown, foreign, old] }));
    const resumed = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    await syncNationalCorridasBR(resumed, async () => ({ url: secondUrl, nextUrls: [firstUrl], events: [unknown, foreign, old] }));
    const nextState = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    await syncNationalCorridasBR(nextState, async () => ({ url: "https://www.corridasbr.com.br/es/calendario.asp",
      nextUrls: [], events: [candidate("corridas-es", "ES", "BR")] }));
    const final = await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
    expect(final).toMatchObject({ status: "completed", discovered: 2, processed: 2 });
    expect((final.snapshot as { receipts: unknown[] }).receipts).toEqual([
      expect.objectContaining({ state: "SC", scope: "source_partition", rawCount: 6, unique: 3, unknownCountry: 2, outOfScope: 1 }),
      expect.objectContaining({ state: "ES", scope: "source_partition", rawCount: 1, unique: 1, unknownCountry: 0, outOfScope: 0 }),
    ]);
    expect(await prisma.event.findUniqueOrThrow({ where: { sourceType_sourceExternalId: {
      sourceType: "corridasbr", sourceExternalId: unknown.externalId } } })).toMatchObject({
        country: null, state: "SC", publicationStatus: "pending_review", warnings: ["country_unconfirmed"],
      });
    expect(await prisma.event.count({ where: { sourceType: "corridasbr", sourceExternalId: foreign.externalId } })).toBe(0);
    expect(await prisma.event.count({ where: { sourceType: "corridasbr", sourceExternalId: old.externalId } })).toBe(0);
    expect(await prisma.collectionTask.count({ where: { ownerId: prefix, kind: "check-source",
      payload: { path: ["syncId"], equals: sync.id } } })).toBe(2);
  });
  it("rejects the old CorridasBR checkpoint before discovery without destroying its history", async () => {
    const { sync, task } = await fixture("corridas-old-country", ["SC"], "corridasbr");
    const previous = { corridasVersion: 1, candidates: [], seenIds: [], visitedUrls: [], receipts: [] };
    const current = await prisma.catalogSync.update({ where: { id: sync.id }, data: { snapshot: previous } });
    setTaskLease(task);
    let calls = 0;
    await expect(syncNationalCorridasBR(current, async () => { calls++; throw Error("unexpected_discovery"); }))
      .rejects.toThrow("catalog_checkpoint_incompatible");
    expect(calls).toBe(0);
    expect((await prisma.catalogSync.findUniqueOrThrow({ where: { id: sync.id } })).snapshot).toEqual(previous);
  });
});
