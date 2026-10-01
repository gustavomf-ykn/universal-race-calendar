import { expect, it } from "vitest";
import { ScraperHttpError } from "@race-calendar/scraper";
import { taskError } from "../apps/worker/src/task-error.js";
it("stops automatic retries on blocking and catalog corruption without exposing upstream details", () => {
  expect(taskError(new ScraperHttpError("private response body", "https://example.test/?secret=not-a-real-secret", 403)))
    .toEqual({ code: "source_access_blocked", retryable: false });
  expect(taskError(new Error("catalog_end_unconfirmed"))).toEqual({ code: "catalog_end_unconfirmed", retryable: false });
  expect(taskError(new Error("URL with private details"))).toEqual({ code: "collection_failed", retryable: true });
});
