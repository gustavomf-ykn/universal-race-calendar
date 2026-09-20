import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
export function publicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return !blocked.check(ip, "ipv4");
  if (kind === 6) return /^[23][0-9a-f]{3}:/i.test(ip) && !blocked.check(ip, "ipv6");
  return false;
}
export function validateSourceUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    isIP(url.hostname.replace(/^\[|\]$/g, ""))
  )
    throw new Error("unsafe_source_url");
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || !url.hostname.includes("."))
    throw new Error("unsafe_source_host");
  return url;
}
// Resolve every redirect, reject the entire answer set if any address is private,
// and pin the approved address in the socket lookup (prevents DNS rebinding).
export async function safeResponse(
  raw: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes = 10 * 1024 * 1024,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let url = validateSourceUrl(raw);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("source_timeout");
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("dns_timeout")), remaining);
        timer.unref();
      }),
    ]);
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw new Error("unsafe_source_address");
    const address = addresses[0]!;
    const response = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>(
      (resolve, reject) => {
        const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
          url,
          {
            headers,
            family: address.family,
            lookup: (_host, _options, cb) => cb(null, address.address, address.family),
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxBytes) {
                req.destroy(new Error("source_too_large"));
                return;
              }
              chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 502,
                headers: Object.fromEntries(
                  Object.entries(res.headers).filter(([, v]) => typeof v === "string"),
                ) as Record<string, string>,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        const timer = setTimeout(() => req.destroy(new Error("source_timeout")), Math.max(1, deadline - Date.now()));
        req.on("close", () => clearTimeout(timer));
        req.on("error", reject);
        req.end();
      },
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3 || !response.headers.location) throw new Error("source_redirect_limit");
      const next = validateSourceUrl(new URL(response.headers.location, url).href);
      if (url.protocol === "https:" && next.protocol !== "https:") throw new Error("source_redirect_downgrade");
      url = next;
      continue;
    }
    return new Response(new Uint8Array(response.body), { status: response.status, headers: response.headers });
  }
  throw new Error("source_redirect_limit");
}
