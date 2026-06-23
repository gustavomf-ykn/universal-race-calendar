import { createSource, prisma } from "./index.js";

async function main() {
  const existing = await prisma.source.findFirst({ where: { url: "mock://corrida-floripa" } });
  if (!existing) {
    await createSource({
      name: "Corrida Mock Floripa",
      url: "mock://corrida-floripa",
      type: "registration_page",
      country: "BR",
      state: "SC",
      city: "Florianopolis",
      adapter: "mock",
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
