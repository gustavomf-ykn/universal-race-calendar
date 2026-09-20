import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "@race-calendar/database";

export type Principal = { id: string; admin: boolean; scopes: string[] };
declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export const keyHash = (value: string) => createHash("sha256").update(value).digest("hex");
function equalSecret(a: string, b: string) {
  return timingSafeEqual(Buffer.from(keyHash(a)), Buffer.from(keyHash(b)));
}
export async function authenticate(request: FastifyRequest): Promise<Principal | null> {
  if (request.principal) return request.principal;
  const internal = request.headers["x-api-key"];
  if (
    typeof internal === "string" &&
    process.env.INTERNAL_API_KEY &&
    equalSecret(internal, process.env.INTERNAL_API_KEY)
  )
    return (request.principal = { id: "internal-scheduler", admin: true, scopes: ["*"] });
  const clientKey = request.headers["x-client-key"];
  if (typeof clientKey === "string") {
    const key = await prisma.apiCredential.findUnique({ where: { keyHash: keyHash(clientKey) } });
    if (!key || key.revokedAt) return null;
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "ApiUsage" ("credentialId","window",count) VALUES (${key.id},date_trunc('hour',now()),1)
      ON CONFLICT ("credentialId","window") DO UPDATE SET count="ApiUsage".count+1
      WHERE "ApiUsage".count < ${key.limitPerHour} RETURNING count`;
    if (!rows.length) throw Object.assign(new Error("rate_limit_exceeded"), { statusCode: 429 });
    return (request.principal = { id: `key:${key.id}`, admin: false, scopes: key.scopes });
  }
  const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  if (!token || !base) return null;
  try {
    if (!jwks.has(base))
      jwks.set(base, createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`), { timeoutDuration: 5000 }));
    const { payload } = await jwtVerify(token, jwks.get(base)!, {
      issuer: `${base}/auth/v1`,
      audience: "authenticated",
      algorithms: ["ES256", "RS256"],
    });
    if (!payload.sub || !payload.exp || payload.role !== "authenticated") return null;
    const metadata = payload.app_metadata as { role?: string } | undefined;
    return (request.principal = {
      id: `user:${payload.sub}`,
      admin: metadata?.role === "admin",
      scopes: ["results:read", "exports:write", "tasks:read"],
    });
  } catch {
    return null;
  }
}
export function authorize(scope: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticate(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!user.admin && (scope === "admin" || !user.scopes.includes(scope)))
      return reply.code(403).send({ error: "forbidden" });
  };
}
export const requireAdmin = authorize("admin");
