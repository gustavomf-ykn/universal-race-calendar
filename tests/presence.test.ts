import { describe, expect, it } from "vitest";
import { presentWorker } from "../packages/database/src/presence.js";
const row = { id: "test", runtime: "python", capabilities: ["exports"], state: "available", activeTaskId: null, version: "test", startedAt: new Date(), lastSeenAt: new Date(), ageSeconds: 0 };
describe("worker presence is separate from task leases", () => {
  it("shows an idle worker with no active task", () => expect(presentWorker(row).state).toBe("available"));
  it("expires stale idle and busy presence", () => {
    expect(presentWorker({ ...row, ageSeconds: 76 }).state).toBe("disconnected");
    expect(presentWorker({ ...row, state: "busy", ageSeconds: 76 }).state).toBe("disconnected");
    expect(presentWorker({ ...row, state: "busy", activeTaskId: "a" }).state).toBe("busy");
  });
  it("does not advertise a stopped worker as available", () => expect(presentWorker({ ...row, state: "stopped" }).state).toBe("disconnected"));
});
