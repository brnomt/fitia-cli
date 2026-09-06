import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type Fetch, FitiaClient } from "./api.ts";
import { cleanToken, requireToken, tokenStatus } from "./auth.ts";
import { CliError } from "./errors.ts";
import { keychain, type SavedSession, type SessionStore } from "./keychain.ts";

export const FIREBASE_KEY = "AIzaSyDuydfUsIFGRZttSiB3mEy0yBwAnnAa2yA";
export async function sessionCredentials(
  store: SessionStore = keychain,
  refresh = true,
  fetcher: Fetch = fetch,
): Promise<{ token: string; uid: string } | undefined> {
  const saved = await store.read();
  if (!saved) return undefined;
  cleanToken(saved.idToken);
  const expiry = tokenStatus(saved.idToken, "keychain").expiresAt;
  if (!refresh || (expiry && Date.parse(expiry) > Date.now() + 60000)) return { token: saved.idToken, uid: saved.uid };
  let response: Response;
  try {
    response = await fetcher(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refreshToken }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new CliError(
      "AUTH_REFRESH_FAILED",
      "Could not refresh the saved session.",
      "Check your connection or run fitia auth login --wait 300.",
      3,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CliError(
      "AUTH_REFRESH_REJECTED",
      "The saved session could not be refreshed.",
      "Run fitia auth login --wait 300 again.",
      3,
    );
  }
  const result = await smallJson(response);
  const idToken = requireToken(cleanToken(result.id_token));
  if (
    result.user_id !== saved.uid ||
    typeof result.refresh_token !== "string" ||
    !result.refresh_token ||
    result.refresh_token.length > 16384
  )
    throw new CliError(
      "AUTH_ACCOUNT_MISMATCH",
      "The refreshed session did not match the saved account.",
      "Run fitia auth login --wait 300 again.",
      3,
    );
  const account = await new FitiaClient(idToken, 15000, fetcher).account();
  if (account.id !== saved.uid)
    throw new CliError("AUTH_ACCOUNT_MISMATCH", "Account verification failed.", "Sign in again.", 3);
  await store.save({ ...saved, idToken, refreshToken: result.refresh_token });
  return { token: idToken, uid: saved.uid };
}

export async function sessionToken(store: SessionStore = keychain, refresh = true, fetcher: Fetch = fetch) {
  return (await sessionCredentials(store, refresh, fetcher))?.token;
}

async function smallJson(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new CliError("AUTH_RESPONSE_INVALID", "Invalid authentication response.", "Sign in again.", 3);
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new CliError("AUTH_RESPONSE_INVALID", "Authentication response was too large.", "Sign in again.", 3);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CliError("AUTH_RESPONSE_INVALID", "Invalid authentication response.", "Sign in again.", 3);
  }
}

function loginPage(nonce: string, csrf: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fitia CLI sign in</title></head>
<body style="font-family:system-ui;max-width:580px;margin:80px auto;padding:20px"><h1>Connect Fitia CLI</h1>
<p>This unofficial CLI connects to your existing Fitia account. Choose the same Google account you use in Fitia.</p>
<p>Your new session will be saved in macOS Keychain so the CLI can refresh it. No meals are changed by signing in. Run <code>fitia auth logout</code> to remove it.</p>
<button id="login" style="padding:14px 24px" disabled>Continue with Google</button><p id="status" role="status">Loading secure sign in…</p>
<script type="module" nonce="${nonce}">
import {initializeApp} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import {initializeAuth,inMemoryPersistence,browserPopupRedirectResolver,signInWithPopup,GoogleAuthProvider} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
const app=initializeApp({apiKey:'${FIREBASE_KEY}',authDomain:'fitia-27c84.firebaseapp.com',projectId:'fitia-27c84'});
const auth=initializeAuth(app,{persistence:inMemoryPersistence,popupRedirectResolver:browserPopupRedirectResolver});
const button=document.getElementById('login'),status=document.getElementById('status');button.disabled=false;status.textContent='Ready.';
button.onclick=async()=>{button.disabled=true;status.textContent='Complete the Google sign in popup.';try{
const result=await signInWithPopup(auth,new GoogleAuthProvider());
const response=await fetch(location.pathname+'/complete',{method:'POST',headers:{'Content-Type':'application/json','X-Fitia-Login':'${csrf}'},body:JSON.stringify({idToken:await result.user.getIdToken(),refreshToken:result.user.refreshToken})});
if(!response.ok)throw Error();status.textContent='Connected. Your session is saved in macOS Keychain. Return to the CLI.';
}catch{status.textContent='Sign in was not completed. Try again with your existing Fitia account, or check the CLI error.';button.disabled=false;}};
</script></body></html>`;
}

export async function startLogin(options: {
  waitSeconds: number;
  store?: SessionStore;
  fetcher?: Fetch;
  onReady?: (url: string) => void;
}) {
  const store = options.store ?? keychain,
    fetcher = options.fetcher ?? fetch;
  const secret = randomBytes(32).toString("hex"),
    csrf = randomBytes(32).toString("hex"),
    nonce = randomBytes(24).toString("base64");
  let origin = "",
    processing = false;
  let resolve!: (value: { accountId: string; email: string | null; storage: string; expiresAt: string | null }) => void;
  let reject!: (error: unknown) => void;
  const completed = new Promise<Awaited<ReturnType<typeof finishLogin>>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // The consumer may attach after the server begins listening.
  completed.catch(() => {});
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    if (req.headers.host !== new URL(origin).host) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && req.url === `/${secret}`) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com; style-src 'unsafe-inline'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com; frame-src https://fitia-27c84.firebaseapp.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      );
      res.end(loginPage(nonce, csrf));
      return;
    }
    if (req.method !== "POST" || req.url !== `/${secret}/complete`) {
      res.writeHead(404).end();
      return;
    }
    if (
      req.headers.origin !== origin ||
      req.headers["x-fitia-login"] !== csrf ||
      req.headers["content-type"] !== "application/json"
    ) {
      res.writeHead(403).end();
      return;
    }
    if (processing) {
      res.writeHead(409).end();
      return;
    }
    processing = true;
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 32768)
          throw new CliError("AUTH_INPUT_INVALID", "Login data exceeded the size limit.", "Try signing in again.", 3);
      }
      const data = JSON.parse(body);
      const result = await finishLogin(data, store, fetcher);
      res.end("Connected");
      resolve(result);
    } catch (error) {
      res.writeHead(400).end("Login failed");
      reject(
        error instanceof CliError
          ? error
          : new CliError("AUTH_INPUT_INVALID", "The sign in response was invalid.", "Try again.", 3),
      );
    }
  }
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500).end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => yes());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new CliError("LOGIN_SERVER_FAILED", "Could not start local sign in.", "Try again.", 5);
  origin = `http://localhost:${address.port}`;
  const timer = setTimeout(
    () =>
      reject(new CliError("LOGIN_TIMEOUT", "Sign in timed out.", "Run fitia auth login --wait 300 to try again.", 3)),
    options.waitSeconds * 1000,
  );
  const stop = () =>
    reject(
      new CliError(
        "LOGIN_CANCELLED",
        "Sign in was cancelled.",
        "No new session was saved unless sign in had already completed.",
        3,
      ),
    );
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const result = completed.finally(() => {
    clearTimeout(timer);
    const signals = process as unknown as {
      removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): void;
    };
    signals.removeListener("SIGINT", stop);
    signals.removeListener("SIGTERM", stop);
    server.closeAllConnections();
    server.close();
  });
  options.onReady?.(`${origin}/${secret}`);
  return { url: `${origin}/${secret}`, result };
}

export async function saveVerifiedSession(
  data: { idToken: unknown; refreshToken: unknown },
  store: SessionStore,
  fetcher: Fetch = fetch,
  storage: "macos-keychain" | "file" = "file",
): Promise<{ accountId: string; email: string | null; storage: string; expiresAt: string | null }> {
  const idToken = requireToken(cleanToken(typeof data.idToken === "string" ? data.idToken : undefined));
  if (
    typeof data.refreshToken !== "string" ||
    !data.refreshToken ||
    data.refreshToken.length > 16384 ||
    /[\x00-\x20]/.test(data.refreshToken)
  )
    throw new CliError("AUTH_INPUT_INVALID", "Invalid refresh token.", "Sign in again.", 3);
  const client = new FitiaClient(idToken, 15000, fetcher);
  const account = await client.account();
  // A Google sign in alone can create a Firebase identity. Require the existing
  // Fitia profile before saving anything for the CLI.
  await client.profile();
  const session: SavedSession = {
    version: 1,
    idToken,
    refreshToken: data.refreshToken,
    uid: account.id,
    email: account.email,
  };
  await store.save(session);
  return {
    accountId: account.id,
    email: account.email,
    storage,
    expiresAt: tokenStatus(idToken, storage === "file" ? "file" : "keychain").expiresAt,
  };
}

export async function loginWithPassword(email: string, password: string, store: SessionStore, fetcher: Fetch = fetch) {
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
    throw new CliError("AUTH_INPUT_INVALID", "Invalid email address.", "Enter the email used in Fitia.", 3);
  if (!password || password.length > 256)
    throw new CliError("AUTH_INPUT_INVALID", "Invalid password.", "Enter the Fitia account password.", 3);
  let response: Response;
  try {
    response = await fetcher(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, password, returnSecureToken: true }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new CliError(
      "AUTH_LOGIN_FAILED",
      "Could not sign in with email and password.",
      "Check your connection and try again.",
      3,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CliError(
      "AUTH_LOGIN_REJECTED",
      "The email or password was not accepted.",
      "Use the same Fitia credentials as in the app, or sign in with Google.",
      3,
    );
  }
  const result = await smallJson(response);
  return saveVerifiedSession({ idToken: result.idToken, refreshToken: result.refreshToken }, store, fetcher, "file");
}

async function finishLogin(data: any, store: SessionStore, fetcher: Fetch) {
  return saveVerifiedSession(data, store, fetcher, "macos-keychain");
}

export function openLogin(url: string) {
  if (process.platform !== "darwin") return;
  const child = spawn("/usr/bin/open", [url], { stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
