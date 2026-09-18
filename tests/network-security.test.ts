import { describe, expect, it, vi } from "vitest";
import { publicAddress, validateSourceUrl, safeResponse } from "../packages/scraper/src/safe-http.js";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]) }));
describe("source network boundary", () => {
  it("rejects private, reserved, loopback and mapped IP destinations", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.1.1",
      "172.16.1.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "2002:7f00:1::",
    ])
      expect(publicAddress(ip), ip).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("rejects credentials, custom ports and non-web protocols", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/a",
      "https://u:p@example.com/a",
      "https://example.com:8080",
      "http://127.0.0.1",
      "http://localhost",
    ])
      expect(() => validateSourceUrl(url)).toThrow();
  });
  it("rejects a public hostname resolving to a private address before opening a socket", async () => {
    await expect(safeResponse("https://example.com", {}, 1000)).rejects.toThrow("unsafe_source_address");
  });
});
