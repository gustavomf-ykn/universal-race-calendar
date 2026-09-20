import { writeFile } from "node:fs/promises";
import { buildApp } from "../apps/api/dist/apps/api/src/app.js";
const app = await buildApp();
await app.ready();
await writeFile(new URL("../docs/openapi.json", import.meta.url), JSON.stringify(app.swagger(), null, 2) + "\n");
await app.close();
