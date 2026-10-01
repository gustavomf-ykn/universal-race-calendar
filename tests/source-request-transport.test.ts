import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeResponse, setSourceRequestGuard, withSourceRequestScope } from "../packages/scraper/src/safe-http.js";
import { ScraperHttpClient } from "../packages/scraper/src/index.js";
import { request as httpsRequest } from "node:https";
const responses = vi.hoisted(() => [] as Array<{ status: number; headers?: Record<string, string> }>);
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));
vi.mock("node:https", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    request: vi.fn((_url, _options, callback) => {
      const request = new EventEmitter() as any;
      request.destroy = (error: Error) => {
        request.emit("error", error);
        request.emit("close");
      };
      request.end = () =>
        queueMicrotask(() => {
          const res = new EventEmitter() as any;
          const next = responses.shift() ?? { status: 200 };
          res.statusCode = next.status;
          res.headers = next.headers ?? {};
          callback(res);
          res.emit("data", Buffer.from("ok"));
          res.emit("end");
          request.emit("close");
        });
      return request;
    }),
  };
});
describe("budget covers actual TypeScript transport", () => {
  beforeEach(() => {
    responses.length = 0;
    vi.clearAllMocks();
  });
  afterEach(() => {
    setSourceRequestGuard(undefined);
  });
  it("does not open a socket or retry when the shared budget defers work", async () => {
    const error = Object.assign(new Error("source_budget_wait"), { name: "SourceBudgetDeferred" });
    const guard = vi.fn(async () => {
      throw error;
    });
    setSourceRequestGuard(guard);
    const client = new ScraperHttpClient({ timeoutMs: 1000 });
    await expect(client.getText("https://www.ticketsports.com.br/")).rejects.toBe(error);
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledTimes(1);
  });
  it("reserves redirects separately and observes the first 429 without repeated requests", async () => {
    responses.push(
      { status: 302, headers: { location: "/second" } },
      { status: 429, headers: { "retry-after": "60" } },
    );
    const guard = vi.fn(async () => {}),
      observer = vi.fn(async () => {});
    setSourceRequestGuard(guard, observer);
    await expect(
      withSourceRequestScope("ticketsports", () =>
        new ScraperHttpClient({ timeoutMs: 1000 }).getText("https://www.ticketsports.com.br/first"),
      ),
    ).rejects.toThrow();
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard.mock.calls[1]).toEqual(["https://www.ticketsports.com.br/second", "ticketsports"]);
    expect(observer.mock.calls[1]).toEqual(["https://www.ticketsports.com.br/second", "ticketsports", 429, "60"]);
    expect(httpsRequest).toHaveBeenCalledTimes(2);
  });
  it("keeps concurrent request scopes separate and excludes courtesy waits from network timeouts", async () => {
    const guard = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    setSourceRequestGuard(guard);
    await Promise.all(
      ["ticketsports", "corridasbr"].map((source) =>
        withSourceRequestScope(source, () => safeResponse("https://example.com/", {}, 20)),
      ),
    );
    expect(guard.mock.calls.map((call) => call[1]).sort()).toEqual(["corridasbr", "ticketsports"]);
    expect(httpsRequest).toHaveBeenCalledTimes(2);
  });
});
