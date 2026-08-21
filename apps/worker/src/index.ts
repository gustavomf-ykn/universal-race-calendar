import {
  auditCuration,
  importCorridasBREvents,
  importTicketSportsEvents,
  runAICurationBatch,
  runAICurationForEvent,
  runSourceCheck,
} from "@race-calendar/curation";
import { getSource, listSources, prisma } from "@race-calendar/database";

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "help";
  if (command === "check-source") {
    const sourceId = argv[1];
    if (!sourceId) throw new Error("Usage: pnpm --filter @race-calendar/worker check-source <sourceId>");
    const source = await getSource(sourceId);
    if (!source) throw new Error(`Source not found: ${sourceId}`);
    const result = await runSourceCheck(source.id);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "list-sources") {
    console.log(JSON.stringify(await listSources(), null, 2));
    return;
  }

  if (command === "import-ticketsports") {
    const options = parseOptions(argv.slice(1));
    const result = await importTicketSportsEvents({
      quantity: positiveInt(options.quantity, Number(process.env.TICKETSPORTS_IMPORT_QUANTITY ?? 2000)),
      offset: nonNegativeInt(options.offset, 0),
      concurrency: positiveInt(options.concurrency, Number(process.env.TICKETSPORTS_IMPORT_CONCURRENCY ?? 3)),
      delayMs: nonNegativeInt(options["delay-ms"], Number(process.env.TICKETSPORTS_IMPORT_DELAY_MS ?? 300)),
      force: options.force === "true",
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "import-corridasbr") {
    const options = parseOptions(argv.slice(1));
    const states = options.states?.split(",").map((state) => state.trim().toUpperCase()).filter(Boolean);
    const result = await importCorridasBREvents({
      ...(states?.length ? { states } : {}),
      quantity: positiveInt(options.quantity, Number(process.env.CORRIDASBR_IMPORT_QUANTITY ?? 5000)),
      offset: nonNegativeInt(options.offset, 0),
      concurrency: positiveInt(options.concurrency, Number(process.env.CORRIDASBR_IMPORT_CONCURRENCY ?? 2)),
      delayMs: nonNegativeInt(options["delay-ms"], Number(process.env.CORRIDASBR_IMPORT_DELAY_MS ?? 500)),
      force: options.force === "true",
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "export-events") {
    const options = parseOptions(argv.slice(1));
    const limit = positiveInt(options.limit, 100);
    const where = {
      publicationStatus: "published" as const,
      ...(options.sourceType ? { sourceType: options.sourceType } : {}),
    };
    const rows = await prisma.event.findMany({
      where,
      include: {
        distances: true,
        prices: true,
        images: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { date: "asc" },
      take: Math.min(limit, 1000),
    });
    console.log(
      JSON.stringify(
        rows.map((event) => ({
          id: event.id,
          slug: event.slug,
          name: event.name,
          date: event.date?.toISOString().slice(0, 10) ?? null,
          startTime: event.startTime,
          city: event.city,
          state: event.state,
          country: event.country,
          locationName: event.locationName,
          address: event.address,
          modality: event.modality,
          eventStatus: event.eventStatus,
          registrationUrl: event.registrationUrl,
          officialUrl: event.officialUrl,
          mainImageUrl: event.mainImageUrl,
          sourceType: event.sourceType,
          sourceExternalId: event.sourceExternalId,
          distances: event.distances.map((distance) => ({
            label: distance.label,
            distanceKm: distance.distanceKm,
          })),
          prices: event.prices.map((price) => ({
            name: price.name,
            price: price.price,
            currency: price.currency,
          })),
          images: event.images.map((image) => image.url),
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (command === "curate:ai") {
    const options = parseOptions(argv.slice(1));
    const dryRun = options["dry-run"] === "true";
    const force = options.force === "true";
    if (options["event-id"]) {
      const result = await runAICurationForEvent(options["event-id"], { dryRun, force });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const result = await runAICurationBatch({
      limit: positiveInt(options.limit, 10),
      only: curationOnlyValue(options.only),
      dryRun,
      force,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "audit:curation") {
    console.log(JSON.stringify(await auditCuration(), null, 2));
    return;
  }

  console.log("Commands:");
  console.log("  check-source <sourceId>");
  console.log("  curate:ai [--event-id=<id>] [--limit=10] [--dry-run] [--force] [--only=not_curated|published|pending_review|failed]");
  console.log("  export-events [--sourceType=ticketsports] [--limit=100]");
  console.log("  import-ticketsports [--quantity=2000] [--offset=0] [--concurrency=3] [--delay-ms=300] [--force]");
  console.log("  import-corridasbr [--states=SP,RJ] [--quantity=5000] [--offset=0] [--concurrency=2] [--delay-ms=500] [--force]");
  console.log("  audit:curation");
  console.log("  list-sources");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

function parseOptions(args: string[]): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match?.[1]) {
      entries.push([match[1], match[2] ?? ""]);
      continue;
    }
    const flag = arg.match(/^--(.+)$/)?.[1];
    if (!flag) continue;
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      entries.push([flag, next]);
      index += 1;
    } else {
      entries.push([flag, "true"]);
    }
  }
  return Object.fromEntries(entries);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function curationOnlyValue(value: string | undefined): "not_curated" | "published" | "pending_review" | "failed" | undefined {
  return value === "not_curated" || value === "published" || value === "pending_review" || value === "failed" ? value : undefined;
}
