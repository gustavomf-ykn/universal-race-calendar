import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../apps/api/src/app.js";

describe("API public and guarded routes without database", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    process.env.INTERNAL_API_KEY = "test-internal-key";
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves health and OpenAPI documents", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const openapi = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    const body = openapi.json<{ openapi: string; info: { title: string } }>();
    expect(body.openapi).toBeDefined();
    expect(body.info.title).toBe("Universal Race Calendar API");
  });

  it("adds CORS headers to public responses", async () => {
    process.env.CORS_ORIGINS = "https://example.test";
    const corsApp = await buildApp();
    const response = await corsApp.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://example.test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://example.test");
    await corsApp.close();
  });

  it("guards internal routes before they access the database", async () => {
    const unauthorized = await app.inject({ method: "GET", url: "/v1/sources" });
    expect(unauthorized.statusCode).toBe(401);

    const invalidSource = await app.inject({
      method: "POST",
      url: "/v1/sources",
      headers: { "x-api-key": "test-internal-key" },
      payload: {
        name: "Fonte invalida",
        url: "not a url",
        type: "registration_page",
      },
    });
    expect(invalidSource.statusCode).toBe(400);
    expect(invalidSource.json()).toEqual({ error: "invalid_url" });
  });
});
