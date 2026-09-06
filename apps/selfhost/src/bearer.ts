import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Bearer realm="fitia-mcp"',
      "Cache-Control": "no-store",
    },
  });
}

export function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

export function presentedBearer(request: Request): string | undefined {
  const header = request.headers.get("authorization")?.trim();
  if (header) {
    // Accept both "Authorization: Bearer <token>" and the bare "<token>".
    if (header.length > "Bearer ".length && header.toLowerCase().startsWith("bearer ")) {
      const presented = header.slice("Bearer ".length).trim();
      if (presented) return presented;
    } else if (header.length <= 2048) {
      return header;
    }
  }
  const match = request.headers.get("cookie")?.match(/(?:^|;\s*)fitia_access=([^;]+)/);
  if (!match?.[1]) return undefined;
  try {
    const value = decodeURIComponent(match[1]);
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function accessCookie(token: string, secure: boolean) {
  return [
    `fitia_access=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=2592000",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function requireMcpBearer(request: Request, expected: string): Response | undefined {
  // Empty token disables the local bearer gate: intended only when a reverse
  // proxy in front of the container already enforces its own authentication.
  if (!expected) return undefined;
  const presented = presentedBearer(request);
  if (!presented || !equalSecret(presented, expected)) return unauthorized();
  return undefined;
}
