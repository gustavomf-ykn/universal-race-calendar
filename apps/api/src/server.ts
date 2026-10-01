import { buildApp } from "./app.js";

import { prisma } from "@race-calendar/database";
import { requestSource, waitForSourceRequest, observeSourceResponse } from "@race-calendar/database";
import { setSourceRequestGuard } from "@race-calendar/sources";
setSourceRequestGuard((url, scope) => waitForSourceRequest(requestSource(url, scope)), observeSourceResponse);

const port = Number(process.env.PORT ?? 3000);
const app = await buildApp();

await app.listen({ port, host: "0.0.0.0" });

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    void app
      .close()
      .then(() => prisma.$disconnect())
      .catch(() => {
        process.exitCode = 1;
      });
  });
