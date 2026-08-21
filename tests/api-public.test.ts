import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, serializePublicEvent } from "../apps/api/src/app.js";

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

    const version = await app.inject({ method: "GET", url: "/v1/version" });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({
      status: "ok",
      canonicalSchemaVersion: "1.0.0",
      curationPipelineVersion: "1.2.0",
      ticketSportsAdapterVersion: "1.0.0",
    });

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

  it("builds public display data only from safe event fields", () => {
    const publicEvent = serializePublicEvent({
      name: "Evento Seguro",
      city: "Avenida Salvador de Sa, 2",
      state: "RJ",
      mainImageUrl: "https://example.test/capa.jpg",
      registrationUrl: "https://example.test/inscricao",
      distances: [
        { id: "dist_1", label: "5 km", distanceKm: 5, modality: "road", confidence: 0.82, sourceText: "Percurso 5 km" },
        { id: "dist_2", label: "30 km", distanceKm: 30, modality: "road", confidence: 0.82, sourceText: "raio de entrega ate 30 km" },
      ],
      prices: [
        { id: "price_1", name: "Taxa", price: 10, currency: "BRL", confidence: 0.9, sourceText: "taxa retirada de kit R$ 10", isCurrent: true },
        { id: "price_2", name: "Inscricao", price: 120, currency: "BRL", confidence: 0.9, sourceText: "Inscricoes a partir de R$ 120", isCurrent: true },
      ],
      kits: [{ id: "kit_1", name: "Kit", items: ["Camiseta"], confidence: 0.7 }],
      kitPickups: [{ id: "pickup_1", confidence: 0.8, startTime: "06:00", endTime: "07:00" }],
      schedule: [],
      rules: [],
      images: [],
    });

    expect(publicEvent.display.coverImageUrl).toBe("https://example.test/capa.jpg");
    expect(publicEvent.display.locationLabel).toBe("RJ");
    expect(publicEvent.display.distances).toEqual(["5 km"]);
    expect(publicEvent.display.currentPrice).toBe(120);
    expect(publicEvent.display.kitSummary).toBe("Camiseta");
    expect(publicEvent.display.primaryAction).toEqual({
      type: "registration",
      label: "Inscrever-se",
      url: "https://example.test/inscricao",
    });
  });

  it("does not invent a current lot when no price is explicitly current", () => {
    const publicEvent = serializePublicEvent({
      prices: [
        {
          name: "Lote antigo",
          price: 99.9,
          currency: "BRL",
          status: "unknown",
          isCurrent: false,
          sourceText: "Valor de inscricao do lote antigo: R$ 99,90",
          confidence: 0.9,
        },
      ],
      distances: [],
      kits: [],
      kitPickups: [],
      schedule: [],
      rules: [],
      images: [],
    });

    expect(publicEvent.prices).toHaveLength(1);
    expect(publicEvent.currentLot).toBeNull();
    expect(publicEvent.display.currentPrice).toBeNull();
    expect(publicEvent.display.currentLotName).toBeNull();
  });
});
