import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";

const MiB = 1024 * 1024;
export type LocalResourceReason = "local_memory_limit" | "local_disk_limit" | "local_resource_measurement_unavailable";
export type LocalResources = {
  reason: LocalResourceReason | null;
  measuredAt: string;
  memoryAvailableBytes: number | null;
  tempFreeBytes: number | null;
  rssBytes: number | null;
  minMemoryBytes: number;
  minTempBytes: number;
  maxRssBytes: number;
};
export function localResourceLimits(env = process.env) {
  function limit(name: string, fallback: number, minimum: number) {
    const value = env[name] ?? String(fallback);
    if (
      !/^[0-9]+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < minimum ||
      Number(value) > 1048576
    )
      throw Error("invalid_local_resource_limits");
    return Number(value) * MiB;
  }
  return {
    minMemoryBytes: limit("WORKER_MIN_FREE_MEMORY_MB", 512, 128),
    minTempBytes: limit("WORKER_MIN_FREE_TEMP_MB", 1024, 128),
    maxRssBytes: limit("WORKER_MAX_RSS_MB", 1024, 128),
  };
}
export function assessLocalResources(
  measurements: { memoryAvailableBytes: number | null; tempFreeBytes: number | null; rssBytes: number | null },
  limits = localResourceLimits(),
): LocalResources {
  const valid = (value: number | null) => value !== null && Number.isSafeInteger(value) && value >= 0;
  const sample = {
    memoryAvailableBytes: valid(measurements.memoryAvailableBytes) ? measurements.memoryAvailableBytes : null,
    tempFreeBytes: valid(measurements.tempFreeBytes) ? measurements.tempFreeBytes : null,
    rssBytes: valid(measurements.rssBytes) ? measurements.rssBytes : null,
  };
  const reason = Object.values(sample).some((value) => value === null)
    ? "local_resource_measurement_unavailable"
    : sample.memoryAvailableBytes! < limits.minMemoryBytes || sample.rssBytes! >= limits.maxRssBytes
      ? "local_memory_limit"
      : sample.tempFreeBytes! < limits.minTempBytes
        ? "local_disk_limit"
        : null;
  return { ...sample, ...limits, measuredAt: new Date().toISOString(), reason };
}
export function inspectLocalResources(): LocalResources {
  let memoryAvailableBytes: number | null = null,
    tempFreeBytes: number | null = null,
    rssBytes: number | null = null;
  try {
    // Node >=22/libuv accounts for memory available to this process, including
    // container constraints. Do not substitute host free RAM when unavailable.
    memoryAvailableBytes = typeof process.availableMemory === "function" ? process.availableMemory() : null;
    rssBytes = process.memoryUsage.rss();
  } catch {
    /* Unknown measurements never authorize acquisition. */
  }
  try {
    const disks = [tmpdir(), process.cwd()].map((path) => statfsSync(path, { bigint: true }));
    tempFreeBytes = Math.min(...disks.map((disk) => Number(disk.bavail * disk.bsize)));
  } catch {
    /* Never expose paths or OS/provider messages. */
  }
  return assessLocalResources({ memoryAvailableBytes, tempFreeBytes, rssBytes });
}
export class LocalResourceDeferred extends Error {
  constructor(readonly snapshot: LocalResources) {
    super(snapshot.reason ?? "local_resource_measurement_unavailable");
    this.name = "LocalResourceDeferred";
  }
}
export function assertLocalResources() {
  const snapshot = inspectLocalResources();
  if (snapshot.reason) throw new LocalResourceDeferred(snapshot);
  return snapshot;
}
