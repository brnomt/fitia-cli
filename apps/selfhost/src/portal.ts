import { FIREBASE_KEY } from "@fitia/core";

export function gatePage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fitia MCP</title>
  <style>
    :root { color-scheme: dark light; font-family: system-ui, sans-serif; }
    body { max-width: 28rem; margin: 4rem auto; padding: 0 1.25rem 3rem; line-height: 1.5; }
    h1 { font-size: 1.5rem; font-weight: 600; }
    .muted { opacity: .72; font-size: .9rem; }
    form { display: grid; gap: .65rem; margin: 1.25rem 0; }
    input, button { padding: .75rem .8rem; font: inherit; }
    button { cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    #status { min-height: 1.4em; }
  </style>
</head>
<body>
  <h1>Fitia MCP</h1>
  <p class="muted">Introduce el token de acceso del contenedor (<code>FITIA_MCP_TOKEN</code>). Sin él no se puede leer ni escribir nada.</p>
  <form id="gate">
    <label>Token de acceso<input name="token" type="password" autocomplete="off" required></label>
    <button type="submit">Desbloquear</button>
  </form>
  <p id="status" role="status"></p>
  <script>
    const form = document.getElementById("gate");
    const status = document.getElementById("status");
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      status.textContent = "Comprobando…";
      try {
        const response = await fetch("/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: form.token.value }),
        });
        if (!response.ok) throw new Error("Token inválido");
        location.reload();
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
      }
    };
  </script>
</body>
</html>`;
}

export function portalPage(nonce: string, csrf: string) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fitia MCP</title>
  <style>
    :root { color-scheme: dark light; font-family: system-ui, sans-serif; }
    body { max-width: 28rem; margin: 4rem auto; padding: 0 1.25rem 3rem; line-height: 1.5; }
    h1 { font-size: 1.5rem; font-weight: 600; }
    p, label { color: CanvasText; }
    .muted { opacity: .72; font-size: .9rem; }
    form, .panel { display: grid; gap: .65rem; margin: 1.25rem 0; }
    input { padding: .7rem .8rem; font: inherit; }
    button { padding: .75rem 1rem; font: inherit; cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    #status { min-height: 1.4em; }
    hr { border: 0; border-top: 1px solid color-mix(in srgb, CanvasText 18%, transparent); margin: 1.5rem 0; }
  </style>
</head>
<body>
  <h1>Fitia MCP</h1>
  <p class="muted">Conecta tu cuenta Fitia a este servidor autoalojado. La sesión se guarda en el volumen del contenedor.</p>
  <div id="app"><p id="status" role="status">Cargando…</p></div>
  <script type="module" nonce="${nonce}">
    const csrf = ${JSON.stringify(csrf)};
    const app = document.getElementById("app");
    const headers = { "Content-Type": "application/json", "X-Fitia-Login": csrf };

    async function json(path, init) {
      const response = await fetch(path, init);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "La solicitud falló");
      return data;
    }

    function setStatus(text) {
      const node = document.getElementById("status");
      if (node) node.textContent = text;
    }

    function connected(status) {
      app.innerHTML = \`
        <div class="panel">
          <p>Conectado como: <strong></strong></p>
          <p class="muted" id="expiry"></p>
          <p id="status" role="status"></p>
          <button id="renew" type="button">Renovar sesión</button>
          <button id="logout" type="button">Cerrar sesión</button>
        </div>\`;
      app.querySelector("strong").textContent = status.email || status.uid || "cuenta Fitia";
      const expiry = document.getElementById("expiry");
      expiry.textContent = status.expired
        ? "El idToken expiró; pulsa renovar para usar el refreshToken."
        : status.expiresAt
          ? "Expira: " + status.expiresAt
          : "";
      document.getElementById("renew").onclick = async () => {
        setStatus("Renovando…");
        try {
          await json("/auth/refresh", { method: "POST", headers });
          await render();
        } catch (error) {
          setStatus(error.message);
        }
      };
      document.getElementById("logout").onclick = async () => {
        setStatus("Cerrando sesión…");
        try {
          await json("/auth/logout", { method: "POST", headers });
          await render();
        } catch (error) {
          setStatus(error.message);
        }
      };
    }

    function login() {
      const localhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
      app.innerHTML = \`
        <form id="password">
          <label>Correo<input name="email" type="email" autocomplete="username" required></label>
          <label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
          <button type="submit">Entrar</button>
        </form>
        <p id="status" role="status"></p>
        <hr>
        <p class="muted">Si tu cuenta Fitia es de Google, el popup solo funciona en localhost. En una IP de LAN usa email y contraseña, un túnel SSH, o copia session.json al volumen.</p>
        <button id="google" type="button" \${localhost ? "" : "disabled"}>Continuar con Google</button>\`;
      document.getElementById("password").onsubmit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector("button");
        button.disabled = true;
        setStatus("Entrando…");
        try {
          await json("/auth/login", {
            method: "POST",
            headers,
            body: JSON.stringify({ email: form.email.value, password: form.password.value }),
          });
          await render();
        } catch (error) {
          setStatus(error.message);
          button.disabled = false;
        }
      };
      const google = document.getElementById("google");
      if (!localhost) return;
      google.onclick = async () => {
        google.disabled = true;
        setStatus("Completa el popup de Google…");
        try {
          const { initializeApp } = await import("https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js");
          const {
            initializeAuth,
            inMemoryPersistence,
            browserPopupRedirectResolver,
            signInWithPopup,
            GoogleAuthProvider,
          } = await import("https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js");
          const firebase = initializeApp({
            apiKey: ${JSON.stringify(FIREBASE_KEY)},
            authDomain: "fitia-27c84.firebaseapp.com",
            projectId: "fitia-27c84",
          });
          const auth = initializeAuth(firebase, {
            persistence: inMemoryPersistence,
            popupRedirectResolver: browserPopupRedirectResolver,
          });
          const result = await signInWithPopup(auth, new GoogleAuthProvider());
          await json("/auth/google", {
            method: "POST",
            headers,
            body: JSON.stringify({ idToken: await result.user.getIdToken(), refreshToken: result.user.refreshToken }),
          });
          await render();
        } catch {
          setStatus("No se completó el acceso con Google. Prueba en localhost o usa email y contraseña.");
          google.disabled = false;
        }
      };
    }

    async function render() {
      const status = await json("/auth/status");
      if (status.linked) connected(status);
      else login();
    }

    render().catch(() => setStatus("No se pudo leer el estado de la sesión."));
  </script>
</body>
</html>`;
}

export function portalHeaders(nonce: string, csrf: string, secureCookie: boolean) {
  const cookie = [
    `fitia_csrf=${csrf}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=3600",
    ...(secureCookie ? ["Secure"] : []),
  ].join("; ");
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com`,
      "style-src 'unsafe-inline'",
      "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
      "frame-src https://fitia-27c84.firebaseapp.com",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Set-Cookie": cookie,
  };
}
