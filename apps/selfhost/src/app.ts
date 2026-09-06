import { randomBytes } from "node:crypto";
import {
  CliError,
  type Fetch,
  loginWithPassword,
  type SessionStore,
  saveVerifiedSession,
  sessionCredentials,
  tokenStatus,
} from "@fitia/core";
import { createServer } from "@fitia/mcp/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { accessCookie, equalSecret, requireMcpBearer } from "./bearer.ts";
import { gatePage, portalHeaders, portalPage } from "./portal.ts";

export interface SelfhostOptions {
  readonly store: SessionStore;
  readonly mcpToken: string;
  readonly fetcher?: Fetch;
  readonly timeoutMs?: number;
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 5;

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded && forwarded.length <= 128 ? forwarded : "local";
}

function csrfFrom(request: Request): string | undefined {
  const match = request.headers.get("cookie")?.match(/(?:^|;\s*)fitia_csrf=([0-9a-f]+)/);
  return match?.[1];
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function httpError(error: unknown) {
  if (error instanceof CliError) {
    const status = error.code === "AUTH_INPUT_INVALID" ? 400 : error.exitCode === 5 ? 500 : 401;
    return jsonError(error.message, status);
  }
  return jsonError("No se pudo completar la solicitud.", 500);
}

async function boundedJson(request: Request, max = 4096): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > max)
    throw new CliError("AUTH_INPUT_INVALID", "Request body too large.", "Retry with a smaller body.", 3);
  const text = await request.text();
  if (Buffer.byteLength(text) > max)
    throw new CliError("AUTH_INPUT_INVALID", "Request body too large.", "Retry with a smaller body.", 3);
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError("AUTH_INPUT_INVALID", "Invalid JSON body.", "Send a JSON object.", 3);
  return value as Record<string, unknown>;
}

export function createSelfhostApp(options: SelfhostOptions) {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs =
    options.timeoutMs &&
    Number.isSafeInteger(options.timeoutMs) &&
    options.timeoutMs >= 1_000 &&
    options.timeoutMs <= 120_000
      ? options.timeoutMs
      : 15_000;
  const failures = new Map<string, { count: number; resetAt: number }>();
  const app = createMcpHonoApp({ host: "0.0.0.0" });

  const requireCsrf = (request: Request): Response | undefined => {
    const cookie = csrfFrom(request);
    const header = request.headers.get("x-fitia-login");
    if (!cookie || !header || !equalSecret(cookie, header)) return jsonError("CSRF token missing or invalid.", 403);
    return undefined;
  };

  const takeLoginSlot = (request: Request): Response | undefined => {
    const ip = clientIp(request);
    const now = Date.now();
    const current = failures.get(ip);
    if (!current || current.resetAt <= now) {
      failures.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
      return undefined;
    }
    if (current.count >= LOGIN_LIMIT) return jsonError("Too many sign-in attempts. Try again later.", 429);
    return undefined;
  };

  const recordLoginFailure = (request: Request) => {
    const ip = clientIp(request);
    const now = Date.now();
    const current = failures.get(ip);
    if (!current || current.resetAt <= now) failures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    else current.count += 1;
  };

  const corsHeaders = (request: Request) => {
    const origin = request.headers.get("origin");
    const allowOrigin = origin && origin !== "null" ? origin : "*";
    return {
      "Access-Control-Allow-Origin": allowOrigin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, X-Fitia-Login",
      "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
      "Access-Control-Max-Age": "86400",
    };
  };

  app.use("*", async (context, next) => {
    const request = context.req.raw;
    const path = new URL(request.url).pathname;
    const method = request.method;

    // Preflight CORS never carries credentials and must not be gated.
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...corsHeaders(request), "Cache-Control": "no-store" } });
    }

    const protectedRoute = path === "/mcp" || path === "/auth" || path.startsWith("/auth/");
    const knownPublic = path === "/" || path === "/health" || path === "/unlock";
    if (!protectedRoute && !knownPublic) return jsonError("Not found.", 404);
    if (protectedRoute) {
      const denied = requireMcpBearer(request, options.mcpToken);
      if (denied) return denied;
    }
    await next();
    context.res.headers.set("Cache-Control", "no-store");
    context.res.headers.set("X-Content-Type-Options", "nosniff");
    context.res.headers.set("Referrer-Policy", "no-referrer");
    if (path === "/mcp" || path === "/health") {
      for (const [key, value] of Object.entries(corsHeaders(request))) context.res.headers.set(key, value);
    }
  });

  app.get("/", (context) => {
    if (requireMcpBearer(context.req.raw, options.mcpToken)) {
      return new Response(gatePage(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        },
      });
    }
    const nonce = randomBytes(24).toString("base64");
    const csrf = randomBytes(32).toString("hex");
    const secure = context.req.url.startsWith("https://");
    const headers = portalHeaders(nonce, csrf, secure);
    return new Response(portalPage(nonce, csrf), { headers });
  });

  app.post("/unlock", async (context) => {
    const limited = takeLoginSlot(context.req.raw);
    if (limited) return limited;
    try {
      const body = await boundedJson(context.req.raw);
      if (typeof body.token !== "string" || !body.token)
        throw new CliError("AUTH_INPUT_INVALID", "Access token is required.", "Enter FITIA_MCP_TOKEN.", 3);
      if (!options.mcpToken || !equalSecret(body.token, options.mcpToken)) {
        recordLoginFailure(context.req.raw);
        return jsonError("Invalid access token.", 401);
      }
      failures.delete(clientIp(context.req.raw));
      const secure = context.req.url.startsWith("https://");
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": accessCookie(options.mcpToken, secure),
        },
      });
    } catch (error) {
      recordLoginFailure(context.req.raw);
      return httpError(error);
    }
  });

  app.get("/health", async (context) => {
    try {
      const saved = await options.store.read();
      return context.json({ ok: true, linked: Boolean(saved) });
    } catch {
      return jsonError("Could not read the session store.", 500);
    }
  });

  app.get("/auth/status", async (context) => {
    try {
      const saved = await options.store.read();
      if (!saved) return context.json({ linked: false, email: null, uid: null, expiresAt: null, expired: null });
      const status = tokenStatus(saved.idToken, "file");
      return context.json({
        linked: true,
        email: saved.email,
        uid: saved.uid,
        expiresAt: status.expiresAt,
        expired: status.expired,
      });
    } catch {
      return jsonError("Could not read the session store.", 500);
    }
  });

  app.post("/auth/login", async (context) => {
    const csrf = requireCsrf(context.req.raw);
    if (csrf) return csrf;
    const limited = takeLoginSlot(context.req.raw);
    if (limited) return limited;
    try {
      const body = await boundedJson(context.req.raw);
      if (typeof body.email !== "string" || typeof body.password !== "string")
        throw new CliError("AUTH_INPUT_INVALID", "Email and password are required.", "Fill both fields.", 3);
      const result = await loginWithPassword(body.email, body.password, options.store, fetcher);
      failures.delete(clientIp(context.req.raw));
      return context.json({ linked: true, email: result.email, accountId: result.accountId });
    } catch (error) {
      recordLoginFailure(context.req.raw);
      return httpError(error);
    }
  });

  app.post("/auth/google", async (context) => {
    const csrf = requireCsrf(context.req.raw);
    if (csrf) return csrf;
    const limited = takeLoginSlot(context.req.raw);
    if (limited) return limited;
    try {
      const body = await boundedJson(context.req.raw, 32_768);
      const result = await saveVerifiedSession(
        { idToken: body.idToken, refreshToken: body.refreshToken },
        options.store,
        fetcher,
        "file",
      );
      failures.delete(clientIp(context.req.raw));
      return context.json({ linked: true, email: result.email, accountId: result.accountId });
    } catch (error) {
      recordLoginFailure(context.req.raw);
      return httpError(error);
    }
  });

  app.post("/auth/refresh", async (context) => {
    const csrf = requireCsrf(context.req.raw);
    if (csrf) return csrf;
    try {
      const creds = await sessionCredentials(options.store, true, fetcher);
      if (!creds) return jsonError("No saved session.", 401);
      const saved = await options.store.read();
      return context.json({
        linked: true,
        email: saved?.email ?? null,
        uid: creds.uid,
        expiresAt: tokenStatus(creds.token, "file").expiresAt,
      });
    } catch (error) {
      return httpError(error);
    }
  });

  app.post("/auth/logout", async (context) => {
    const csrf = requireCsrf(context.req.raw);
    if (csrf) return csrf;
    try {
      await options.store.remove();
      return context.json({ linked: false });
    } catch (error) {
      return httpError(error);
    }
  });

  app.all("/mcp", async (context) => {
    const handler = createMcpHandler(() =>
      createServer({
        timeoutMs,
        getCredentials: () => sessionCredentials(options.store, true, fetcher),
      }),
    );
    return handler.fetch(context.req.raw, { parsedBody: (context.var as { parsedBody?: unknown }).parsedBody });
  });

  return app;
}
