import { describe, expect, it } from "vitest";
import {
  assessLocalResources,
  localResourceLimits,
  inspectLocalResources,
} from "../packages/utils/src/local-resources.js";
const MiB = 1024 * 1024;
const sample = { memoryAvailableBytes: 2048 * MiB, tempFreeBytes: 2048 * MiB, rssBytes: 128 * MiB };
describe("local resource admission", () => {
  it("uses available memory, process RSS and writable disk headroom as independent requirements", () => {
    expect(assessLocalResources(sample).reason).toBeNull();
    expect(assessLocalResources({ ...sample, memoryAvailableBytes: 511 * MiB }).reason).toBe("local_memory_limit");
    expect(assessLocalResources({ ...sample, rssBytes: 1024 * MiB }).reason).toBe("local_memory_limit");
    expect(assessLocalResources({ ...sample, tempFreeBytes: 1023 * MiB }).reason).toBe("local_disk_limit");
    expect(
      assessLocalResources({ memoryAvailableBytes: 512 * MiB, tempFreeBytes: 1024 * MiB, rssBytes: 1024 * MiB - 1 })
        .reason,
    ).toBeNull();
  });
  it.each([null, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
    "does not substitute zero/success for an invalid measurement %s",
    (value) => {
      expect(assessLocalResources({ ...sample, memoryAvailableBytes: value }).reason).toBe(
        "local_resource_measurement_unavailable",
      );
    },
  );
  it("refuses disabled/malformed limits rather than silently removing the guard", () => {
    for (const value of ["0", "127", "-1", "1e3", "128.5", "Infinity", "1048577", "１２８"])
      expect(() => localResourceLimits({ WORKER_MIN_FREE_MEMORY_MB: value })).toThrow("invalid_local_resource_limits");
    expect(localResourceLimits({ WORKER_MIN_FREE_MEMORY_MB: "1024" }).minMemoryBytes).toBe(1024 * MiB);
  });
  it("native measurement exposes only fixed numeric fields, a reason and a timestamp", () => {
    const result = inspectLocalResources();
    expect(Object.keys(result).sort()).toEqual(
      [
        "reason",
        "measuredAt",
        "memoryAvailableBytes",
        "tempFreeBytes",
        "rssBytes",
        "minMemoryBytes",
        "minTempBytes",
        "maxRssBytes",
      ].sort(),
    );
    expect(Date.parse(result.measuredAt)).not.toBeNaN();
    expect(result.rssBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/postgresql:|supabase|Users|SECRET|PASSWORD/i);
  });
});
