import { expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import {
  type Fetch,
  loginWithPassword,
  type SavedSession,
  type SessionStore,
  sessionToken,
  startLogin,
} from "@fitia/core";

const token = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
function memory(initial?: SavedSession) {
  let value = initial;
  return {
    read: async () => value,
    save: async (data: SavedSession) => {
      value = data;
    },
    remove: async () => {
      value = undefined;
    },
  } satisfies SessionStore;
}
const fresh = token(4102444800);
const account: Fetch = async (url) => {
  if (url.includes("accounts:lookup"))
    return Response.json({ users: [{ localId: "test-user", email: "example@example.invalid", emailVerified: true }] });
  if (url.includes("/api/profiles/test-user")) return Response.json({ isPremium: true });
  throw Error("unexpected URL");
};

test("empty store and local status do not contact the network", async () => {
  const noNetwork: Fetch = async () => {
    throw Error("unexpected network");
  };
  expect(await sessionToken(memory(), true, noNetwork)).toBeUndefined();
  const store = memory({ version: 1, idToken: token(1), refreshToken: "test-refresh", uid: "test-user", email: null });
  expect(await sessionToken(store, false, noNetwork)).toBe(token(1));
});
test("refresh rotates secrets only after same-account server verification", async () => {
  const store = memory({ version: 1, idToken: token(1), refreshToken: "test-refresh", uid: "test-user", email: null });
  let requested = 0;
  const fetcher: Fetch = async (url, init) => {
    if (url.startsWith("https://securetoken.googleapis.com/")) {
      requested++;
      expect(init.redirect).toBe("error");
      expect(new URLSearchParams(init.body as string).get("refresh_token")).toBe("test-refresh");
      return Response.json({ id_token: fresh, refresh_token: "rotated-test-refresh", user_id: "test-user" });
    }
    return account(url, init);
  };
  expect(await sessionToken(store, true, fetcher)).toBe(fresh);
  expect((await store.read())?.refreshToken).toBe("rotated-test-refresh");
  expect(await sessionToken(store, true, fetcher)).toBe(fresh);
  expect(requested).toBe(1);
});
test("refresh cannot switch the saved account", async () => {
  const initial: SavedSession = { version: 1, idToken: token(1), refreshToken: "old", uid: "test-user", email: null };
  const store = memory(initial);
  await expect(
    sessionToken(store, true, async () =>
      Response.json({ id_token: fresh, refresh_token: "new", user_id: "another-user" }),
    ),
  ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_MISMATCH" });
  expect(await store.read()).toEqual(initial);
});
test("login callback checks origin and CSRF, saves no browser storage and returns no tokens", async () => {
  const store = memory();
  const login = await startLogin({ waitSeconds: 3, store, fetcher: account });
  const htmlResponse = await fetch(login.url),
    html = await htmlResponse.text();
  expect(htmlResponse.headers.get("cache-control")).toBe("no-store");
  expect(html).toContain("inMemoryPersistence");
  expect(html).not.toContain("localStorage");
  const csrf = html.match(/'X-Fitia-Login':'([a-f0-9]+)'/)![1]!;
  const url = `${login.url}/complete`;
  const body = JSON.stringify({ idToken: fresh, refreshToken: "new-test-refresh" });
  const rejected = await fetch(url, {
    method: "POST",
    headers: { Origin: "https://evil.invalid", "Content-Type": "application/json", "X-Fitia-Login": csrf },
    body,
  });
  expect(rejected.status).toBe(403);
  expect(await store.read()).toBeUndefined();
  const response = await fetch(url, {
    method: "POST",
    headers: { Origin: new URL(login.url).origin, "Content-Type": "application/json", "X-Fitia-Login": csrf },
    body,
  });
  expect(response.status).toBe(200);
  const result = await login.result;
  expect(result.accountId).toBe("test-user");
  expect(JSON.stringify(result)).not.toContain(fresh);
  expect((await store.read())?.refreshToken).toBe("new-test-refresh");
});
test("login completes when the callback client disconnects after the session is saved", async () => {
  let value: SavedSession | undefined, socket: Socket | undefined;
  let saved!: () => void, resumeSave!: () => void;
  const didSave = new Promise<void>((resolve) => {
    saved = resolve;
  });
  const canResumeSave = new Promise<void>((resolve) => {
    resumeSave = resolve;
  });
  const store: SessionStore = {
    read: async () => value,
    save: async (data) => {
      value = data;
      saved();
      await canResumeSave;
    },
    remove: async () => {
      value = undefined;
    },
  };
  const login = await startLogin({ waitSeconds: 1, store, fetcher: account });
  const html = await (await fetch(login.url)).text();
  const csrf = html.match(/'X-Fitia-Login':'([a-f0-9]+)'/)![1]!;
  const url = new URL(login.url),
    body = JSON.stringify({ idToken: fresh, refreshToken: "new-test-refresh" });
  socket = connect(Number(url.port), "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket!.once("connect", resolve);
    socket!.once("error", reject);
  });
  socket.write(
    [
      `POST ${url.pathname}/complete HTTP/1.1`,
      `Host: ${url.host}`,
      `Origin: ${url.origin}`,
      "Content-Type: application/json",
      `X-Fitia-Login: ${csrf}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
  await didSave;
  const disconnected = new Promise<void>((resolve) => socket!.once("close", resolve));
  socket.resetAndDestroy();
  await disconnected;
  await new Promise((resolve) => setTimeout(resolve, 20));
  resumeSave();
  const result = await login.result.catch((error) => error);
  expect(result).toMatchObject({ accountId: "test-user" });
  expect((await store.read())?.refreshToken).toBe("new-test-refresh");
});
test("password login verifies the Fitia profile before saving", async () => {
  const store = memory();
  const fetcher: Fetch = async (url, init) => {
    if (url.includes("accounts:signInWithPassword")) {
      expect(JSON.parse(String(init.body))).toMatchObject({
        email: "example@example.invalid",
        returnSecureToken: true,
      });
      return Response.json({ idToken: fresh, refreshToken: "password-refresh" });
    }
    return account(url, init);
  };
  const result = await loginWithPassword("example@example.invalid", "secret", store, fetcher);
  expect(result).toMatchObject({ accountId: "test-user", storage: "file", email: "example@example.invalid" });
  expect((await store.read())?.refreshToken).toBe("password-refresh");
});

test("password login does not save when Fitia has no profile", async () => {
  const store = memory();
  const fetcher: Fetch = async (url) => {
    if (url.includes("accounts:signInWithPassword"))
      return Response.json({ idToken: fresh, refreshToken: "password-refresh" });
    if (url.includes("accounts:lookup"))
      return Response.json({
        users: [{ localId: "test-user", email: "example@example.invalid", emailVerified: true }],
      });
    if (url.includes("/api/profiles/test-user")) return new Response(null, { status: 404 });
    throw Error("unexpected URL");
  };
  await expect(loginWithPassword("example@example.invalid", "secret", store, fetcher)).rejects.toMatchObject({
    code: "HTTP_ERROR",
  });
  expect(await store.read()).toBeUndefined();
});

test("password login rejects an invalid email without contacting the network", async () => {
  const noNetwork: Fetch = async () => {
    throw Error("unexpected network");
  };
  await expect(loginWithPassword("not-an-email", "secret", memory(), noNetwork)).rejects.toMatchObject({
    code: "AUTH_INPUT_INVALID",
  });
});

test("login deadline closes the server without saving a session", async () => {
  const store = memory(),
    login = await startLogin({ waitSeconds: 0.02, store, fetcher: account });
  await expect(login.result).rejects.toMatchObject({ code: "LOGIN_TIMEOUT" });
  expect(await store.read()).toBeUndefined();
});
