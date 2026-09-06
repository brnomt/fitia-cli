import { expect, test } from "bun:test";
import { type Fetch, operations, type SavedSession, type SessionStore, VERSION } from "@fitia/core";
import { createSelfhostApp } from "../apps/selfhost/src/app.ts";

const token = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
const fresh = token(4102444800);
const mcpToken = "test-mcp-token";

function memory(initial?: SavedSession): SessionStore {
  let value = initial;
  return {
    read: async () => value,
    save: async (data) => {
      value = data;
    },
    remove: async () => {
      value = undefined;
    },
  };
}

const account: Fetch = async (url) => {
  if (url.includes("accounts:lookup"))
    return Response.json({ users: [{ localId: "test-user", email: "example@example.invalid", emailVerified: true }] });
  if (url.includes("/api/profiles/test-user")) return Response.json({ isPremium: true });
  throw Error(`unexpected URL ${url}`);
};

function cookieFrom(response: Response) {
  return response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? "";
}

function csrfFrom(cookie: string) {
  return cookie.match(/fitia_csrf=([0-9a-f]+)/)?.[1] ?? "";
}

async function app(store = memory(), fetcher: Fetch = account) {
  return createSelfhostApp({ store, mcpToken, fetcher });
}

function auth(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${mcpToken}`, ...extra };
}

function sseJson(text: string) {
  const line = text.split("\n").find((entry) => entry.startsWith("data: "));
  if (!line) throw new Error(`missing SSE data: ${text}`);
  return JSON.parse(line.slice(6));
}

test("health stays public and everything else requires the bearer", async () => {
  const server = await app();
  const health = await server.fetch(new Request("http://127.0.0.1:8080/health"));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true, linked: false });
  expect((await server.fetch(new Request("http://127.0.0.1:8080/auth/status"))).status).toBe(401);
  const status = await server.fetch(new Request("http://127.0.0.1:8080/auth/status", { headers: auth() }));
  expect(await status.json()).toMatchObject({ linked: false, email: null });
});

test("unknown and well-known probe paths return 404 without a token", async () => {
  const server = await app();
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/mcp",
    "/nope",
  ]) {
    const response = await server.fetch(new Request(`http://127.0.0.1:8080${path}`));
    expect(response.status, path).toBe(404);
  }
});

test("MCP CORS preflight passes without auth and MCP responses carry CORS headers", async () => {
  const server = await app();
  const preflight = await server.fetch(
    new Request("http://127.0.0.1:8080/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type, mcp-protocol-version",
      },
    }),
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
  expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
  expect(preflight.headers.get("access-control-allow-methods")).toContain("OPTIONS");
  const initialize = await server.fetch(
    new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: auth({
        Origin: "https://app.example.test",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    }),
  );
  expect(initialize.status).toBe(200);
  expect(initialize.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
  expect(sseJson(await initialize.text()).result.serverInfo).toEqual({ name: "fitia", version: VERSION });
});

test("empty token disables the local bearer gate for the proxy", async () => {
  const server = createSelfhostApp({
    store: memory({ version: 1, idToken: fresh, refreshToken: "r", uid: "u", email: null }),
    mcpToken: "",
  });
  const response = await server.fetch(
    new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    }),
  );
  expect(response.status).toBe(200);
});

test("MCP accepts the token bare, with Bearer, or from the access cookie", async () => {
  const server = await app(memory({ version: 1, idToken: fresh, refreshToken: "r", uid: "u", email: null }));
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  for (const authorization of [mcpToken, `Bearer ${mcpToken}`, `bearer ${mcpToken}`]) {
    const response = await server.fetch(
      new Request("http://127.0.0.1:8080/mcp", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body,
      }),
    );
    expect(response.status).toBe(200);
  }
});

test("portal shows a token gate until unlocked", async () => {
  const server = await app();
  const gated = await server.fetch(new Request("http://127.0.0.1:8080/"));
  expect(gated.status).toBe(200);
  expect(await gated.text()).toContain("Token de acceso");
  const unlocked = await server.fetch(new Request("http://127.0.0.1:8080/", { headers: auth() }));
  expect(unlocked.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(cookieFrom(unlocked)).toContain("fitia_csrf=");
  expect(await unlocked.text()).toContain("Conectado como");
});

test("unlock sets an HttpOnly access cookie", async () => {
  const server = await app();
  const denied = await server.fetch(
    new Request("http://127.0.0.1:8080/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    }),
  );
  expect(denied.status).toBe(401);
  const ok = await server.fetch(
    new Request("http://127.0.0.1:8080/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: mcpToken }),
    }),
  );
  expect(ok.status).toBe(200);
  expect(cookieFrom(ok)).toContain("fitia_access=");
  const cookie = cookieFrom(ok);
  const portal = await server.fetch(new Request("http://127.0.0.1:8080/", { headers: { Cookie: cookie } }));
  expect(await portal.text()).toContain("Conectado como");
});

test("password login requires CSRF and persists the session", async () => {
  const store = memory();
  const fetcher: Fetch = async (url, init) => {
    if (url.includes("accounts:signInWithPassword"))
      return Response.json({ idToken: fresh, refreshToken: "portal-refresh" });
    return account(url, init);
  };
  const server = await app(store, fetcher);
  const page = await server.fetch(new Request("http://127.0.0.1:8080/", { headers: auth() }));
  const cookie = cookieFrom(page);
  const csrf = csrfFrom(cookie);
  const rejected = await server.fetch(
    new Request("http://127.0.0.1:8080/auth/login", {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ email: "example@example.invalid", password: "secret" }),
    }),
  );
  expect(rejected.status).toBe(403);
  const ok = await server.fetch(
    new Request("http://127.0.0.1:8080/auth/login", {
      method: "POST",
      headers: auth({
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Fitia-Login": csrf,
      }),
      body: JSON.stringify({ email: "example@example.invalid", password: "secret" }),
    }),
  );
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ linked: true, email: "example@example.invalid" });
  expect((await store.read())?.refreshToken).toBe("portal-refresh");
});

test("MCP requires the configured bearer token and lists Fitia tools", async () => {
  const store = memory({
    version: 1,
    idToken: fresh,
    refreshToken: "refresh",
    uid: "test-user",
    email: "example@example.invalid",
  });
  const server = await app(store);
  const denied = await server.fetch(
    new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }),
  );
  expect(denied.status).toBe(401);
  const initialize = await server.fetch(
    new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${mcpToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    }),
  );
  expect(initialize.status).toBe(200);
  expect(sseJson(await initialize.text()).result.serverInfo).toEqual({ name: "fitia", version: VERSION });
  const listed = await server.fetch(
    new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${mcpToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }),
  );
  expect(listed.status).toBe(200);
  const tools = sseJson(await listed.text()).result.tools;
  const mcpOperations = Object.values(operations).filter((operation) => "mcpName" in operation);
  expect(tools).toHaveLength(mcpOperations.length);
});

test("login rate-limits repeated failures from the same client", async () => {
  const store = memory();
  const fetcher: Fetch = async (url) => {
    if (url.includes("accounts:signInWithPassword")) return new Response(null, { status: 400 });
    throw Error(`unexpected URL ${url}`);
  };
  const server = await app(store, fetcher);
  const page = await server.fetch(new Request("http://127.0.0.1:8080/", { headers: auth() }));
  const cookie = cookieFrom(page);
  const csrf = csrfFrom(cookie);
  const attempt = () =>
    server.fetch(
      new Request("http://127.0.0.1:8080/auth/login", {
        method: "POST",
        headers: auth({
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-Fitia-Login": csrf,
          "X-Forwarded-For": "203.0.113.8",
        }),
        body: JSON.stringify({ email: "example@example.invalid", password: "wrong" }),
      }),
    );
  for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
  expect((await attempt()).status).toBe(429);
  expect(await store.read()).toBeUndefined();
});
