import { importTicketSportsEvents, runSourceCheck } from "@race-calendar/curation";
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
    const result = await importTicketSportsEvents();
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

  console.log("Commands:");
  console.log("  check-source <sourceId>");
  console.log("  export-events [--sourceType=ticketsports] [--limit=100]");
  console.log("  import-ticketsports");
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
  return Object.fromEntries(
    args.flatMap((arg) => {
      const match = arg.match(/^--([^=]+)=(.*)$/);
      return match?.[1] ? [[match[1], match[2] ?? ""]] : [];
    }),
  );
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
