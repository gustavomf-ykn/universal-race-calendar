// Operator-selected IDs only. This never cancels/holds/acquires any task.
import { readFileSync } from "node:fs";
import { prisma } from "@race-calendar/database";
try {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (
    input.projectRef !== "sggrijhyblejlgimgzzc" ||
    process.env.SUPABASE_URL !== `https://${input.projectRef}.supabase.co` ||
    input.releaseSha !== process.env.GIT_SHA ||
    !Array.isArray(input.approvedTaskIds) ||
    input.approvedTaskIds.some((id) => typeof id !== "string")
  )
    throw Error();
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const workers = await tx.workerPresence.count({
        where: { lastSeenAt: { gt: new Date(Date.now() - 75000) }, state: { not: "stopped" } },
      });
      const running = await tx.collectionTask.count({ where: { status: "running" } });
      if (workers || running) throw Error();
      const queue = await tx.collectionTask.findMany({
        where: { status: "queued", executionHold: false },
        select: { id: true },
      });
      if (queue.some((t) => !input.approvedTaskIds.includes(t.id))) throw Error();
      console.log(
        JSON.stringify({
          projectRef: input.projectRef,
          eligibleTaskIds: queue.map((t) => t.id),
          noOtherWorkers: true,
          readOnly: true,
        }),
      );
    },
    { timeout: 10000 },
  );
} catch {
  console.error("aws_queue_approval_unconfirmed; inspect pending tasks and other workers");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
