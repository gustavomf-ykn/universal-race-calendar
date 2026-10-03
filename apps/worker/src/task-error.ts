import { ScraperHttpError } from "@race-calendar/scraper";
import { editionFailureCode } from "@race-calendar/database";
const terminalCatalogErrors = new Set([
  "source_access_blocked", "catalog_region_ignored", "catalog_checkpoint_incompatible", "catalog_end_unconfirmed",
  "catalog_structure_changed", "catalog_invalid_candidates", "catalog_quantity_ignored", "catalog_page_url_invalid",
  "catalog_reconciliation_checkpoint_incompatible", "catalog_reconciliation_checkpoint_stale", "catalog_reconciliation_request_invalid",
]);
export function taskError(error: unknown): { code: string; retryable: boolean } {
  const edition = editionFailureCode(error);
  if (edition) return { code: edition, retryable: false };
  if (error instanceof ScraperHttpError && [401, 403, 429].includes(error.statusCode ?? 0))
    return { code: "source_access_blocked", retryable: false };
  if (error instanceof Error && terminalCatalogErrors.has(error.message)) return { code: error.message, retryable: false };
  if (error instanceof Error && error.message === "lease_lost") return { code: "lease_lost", retryable: false };
  // Never persist an upstream error message: it may include URLs, credentials or response bodies.
  return { code: "collection_failed", retryable: true };
}
