import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
describe("native and Docker handoff", () => {
  it("contains only the explicit new target and no embedded database in the local Compose", () => {
    const text = readFileSync("compose.local-staging.yaml", "utf8");
    expect(text).toContain("gpkodfsofwiroskdmeax");
    expect(text).not.toContain("sggrijhyblejlgimgzzc");
    expect(text).not.toMatch(/postgres:\/\//);
    expect(text).toContain("profiles: [workers]");
    expect(text).toContain("scripts/profile-migrate.mjs");
  });
  it("starts the Python profile loader without reading secrets or connecting to a service", () => {
    if (!process.env.TEST_PYTHON) return;
    const run = spawnSync(process.env.TEST_PYTHON, ["-B", "scripts/local-staging.py", "--help"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("configure-gui");
    expect(run.stdout).toContain("quota-confirmed");
  });
});
