import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchRun, workerOptions } from "../apps/worker/src/batch.js";

describe("batch worker budget", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it("preserves continuous mode by default", () => {
    expect(workerOptions({}).batch).toBe(false);
  });
  it("rejects zero, invalid, negative and unbounded budgets", () => {
    for (const value of ["0", "NaN", "-1", "Infinity", "3601"])
      expect(() => workerOptions({ WORKER_MAX_SECONDS: value })).toThrow("invalid_worker_limits");
  });
  it("stops acquiring after task limit", () => {
    vi.stubEnv("WORKER_MODE", "batch");
    vi.stubEnv("WORKER_MAX_TASKS", "2");
    const run = new BatchRun();
    run.claimed = 1;
    expect(run.canClaim()).toBe(true);
    run.claimed = 2;
    expect(run.canClaim()).toBe(false);
    expect(run.reason).toBe("task_limit");
  });
  it("stops acquiring when wall budget has elapsed", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    vi.stubEnv("WORKER_MODE", "batch");
    vi.stubEnv("WORKER_MAX_SECONDS", "1");
    const run = new BatchRun();
    vi.advanceTimersByTime(1001);
    expect(run.canClaim()).toBe(false);
    expect(run.reason).toBe("duration_limit");
  });
});
