# Self-hosted Fitia MCP

Single-user appliance: a login portal plus Streamable HTTP MCP on one port. Fitia ID and refresh tokens stay in a Docker volume. This is not the Clerk/Cloudflare remote described in [remote-mcp.md](remote-mcp.md).

## What you get

- Portal on `GET /` (email/password, optional Google on localhost)
- Session file at `/app/data/session.json`
- Automatic Firebase refresh via the existing core `sessionCredentials()` path
- MCP tools unchanged, served at `POST /mcp` (Streamable HTTP)
- stdio still available with `FITIA_TRANSPORT=stdio`

## Generate a MCP bearer token

Every route except `GET /health` requires this token: portal, `/auth/*`, `/unlock`, and `/mcp`. `GET /` without it only shows the unlock form.

```sh
openssl rand -hex 32
```

Put it in a gitignored `.env` next to `docker-compose.yml`:

```sh
FITIA_MCP_TOKEN=replace-with-the-hex-value
```

> **Warning:** Do not publish 8080 to the internet. Bind it to LAN only. The bearer token protects every route except `/health`.

## Docker Compose

```sh
docker compose up -d --build
curl -sI http://127.0.0.1:8080/health
curl -s -H "Authorization: Bearer $FITIA_MCP_TOKEN" http://127.0.0.1:8080/auth/status
```

Open `http://<host>:8080`, enter `FITIA_MCP_TOKEN` to unlock the portal, sign in with the same Fitia email and password as the app, then point a client at `/mcp`:

```json
{
  "mcpServers": {
    "fitia": {
      "url": "http://<host>:8080/mcp",
      "headers": {
        "Authorization": "Bearer <FITIA_MCP_TOKEN>"
      }
    }
  }
}
```

## Arcane

1. Create the `.env` with `FITIA_MCP_TOKEN` as above.
2. Add a stack from this repository's `docker-compose.yml` (build context = repo root).
3. Publish `8080` to the LAN, not to a public reverse proxy unless you add your own TLS and IP allowlist.
4. Open `http://<arcane-host>:8080`, unlock with `FITIA_MCP_TOKEN`, then sign in to Fitia.
5. Confirm with:

```sh
curl -sI http://<arcane-host>:8080/health
curl -s -H "Authorization: Bearer $FITIA_MCP_TOKEN" http://<arcane-host>:8080/auth/status
```

Umbrel can run the same compose file. An `umbrel-app.yml` is out of scope here.

## Google sign-in limitation

> **Warning:** The Google popup uses Fitia's Firebase project (`fitia-27c84`). Only authorized domains work; `localhost` does, LAN IPs and `umbrel.local` do not. We cannot add your NAS hostname to Fitia's Firebase authorized domains.

Workarounds:

```sh
ssh -L 8080:127.0.0.1:8080 <nas-host>
```

Then open `http://localhost:8080` and use Google, or copy a `session.json` produced by `fitia auth login` on macOS into the `fitia-data` volume.

Email/password login talks to Identity Toolkit from the container and does not need an authorized browser domain.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `FITIA_DATA_DIR` | `/app/data` | Directory for `session.json` |
| `FITIA_PORT` | `8080` | HTTP port |
| `FITIA_HOST` | `0.0.0.0` | Bind address |
| `FITIA_TRANSPORT` | `http` | `http` or `stdio` |
| `FITIA_TIMEOUT_MS` | `15000` | Upstream Fitia timeout |
| `FITIA_MCP_TOKEN` | empty | Bearer token for every route except `/health` (required in compose) |

An empty `FITIA_MCP_TOKEN` leaves `/health` up and returns 401 for every other request. The portal unlock form still renders on `GET /`.

## Volume

`session.json` is version 1: `idToken`, `refreshToken`, `uid`, `email`. The process writes it atomically (`session.json.tmp` then rename) with mode `0600`. Treat the volume as credentials.

If the container user cannot write the mount, fix ownership of the named volume rather than running as root.
