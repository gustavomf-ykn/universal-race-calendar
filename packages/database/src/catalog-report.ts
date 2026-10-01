import type { CatalogSync, CollectionTask } from "@prisma/client";
import { publicTask } from "./tasks.js";

/** Coverage receipts only; never expose candidate snapshots or upstream payloads. */
export function publicCatalogSync(sync: CatalogSync, latestTask: CollectionTask | null) {
  const value = sync.snapshot as { receipts?: unknown[] } | null;
  const receipts = Array.isArray(value?.receipts) ? value.receipts.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.state !== "string" || !/^[A-Z]{2}$/.test(r.state) ||
        !["completed", "limited"].includes(String(r.status)) ||
        typeof r.reason !== "string" || !/^[a-z_]{1,80}$/.test(r.reason) ||
        ![r.requested, r.rawCount, r.unique].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) return [];
    const details: Record<string, number | null | string> = {};
    if (r.scope === "source_catalog") {
      details.scope = "source_catalog";
      for (const key of ["duplicates", "outOfScope", "unknownCountry", "advertisedTotal"]) {
        if (Number.isSafeInteger(r[key]) && Number(r[key]) >= 0) details[key] = Number(r[key]);
        else if (key === "advertisedTotal" && r[key] === null) details[key] = null;
      }
    }
    return [{ state: r.state, status: r.status, reason: r.reason,
      requested: r.requested, rawCount: r.rawCount, unique: r.unique, ...details }];
  }) : [];
  const options = sync.options as { autoContinue?: boolean; pauseRequested?: boolean; states?: string[] };
  return {
    id: sync.id, source: sync.source, options: sync.options, cursor: sync.cursor, page: sync.page,
    status: sync.status, coverage: sync.coverage, discovered: sync.discovered, processed: sync.processed,
    createdAt: sync.createdAt, updatedAt: sync.updatedAt, receipts,
    // Source end evidence is not proof that all candidate metadata and results have been validated.
    discoveryFinished: sync.status === "completed",
    autoContinue: options.autoContinue === true, pauseRequested: options.pauseRequested === true,
    latestTask: latestTask ? publicTask(latestTask) : null,
  };
}
