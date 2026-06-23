import { runSourceCheck } from "@race-calendar/curation";
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

  console.log("Commands:");
  console.log("  check-source <sourceId>");
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
