# Self-hosted Fitia MCP

Single-user appliance: a login portal plus Streamable HTTP MCP on one port. Fitia ID and refresh tokens stay in a Docker volume. This is not the Clerk/Cloudflare remote described in [remote-mcp.md](remote-mcp.md).

## What you get

- Portal on `GET /` (email/password, optional Google on localhost)
- Session file at `/app/data/session.json`
- Automatic Firebase refresh via the existing core `sessionCredentials()` path
- MCP tools unchanged, served at `POST /mcp` (Streamable HTTP)
- stdio still available with `FITIA_TRANSPORT=stdio`

## Auth mode

`FITIA_MCP_TOKEN` can be:

- **empty** — open mode. No local bearer check; a reverse proxy in front (like mcp-proxy with `authTokens`) must enforce auth. Use this when the proxy handles the token.
- **set** — local mode. Every route except `GET /health` requires that bearer token (portal, `/auth/*`, `/unlock`, and `/mcp`).

Generate a local token with `openssl rand -hex 32`.

> **Warning:** Do not publish the port to the internet in open mode. It is meant for LAN-only or behind a fronting proxy that already authenticates.

## Docker Compose

The compose file uses a pre-built `fitia-mcp:local` image (no `build:`). Build and load it first, then start:

```sh
docker build -t fitia-mcp:local .
docker compose up -d
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

Arcane has no host/SSH checkout of this repo, so it cannot run `build: .`. Upload a saved image, then paste compose.

> **Warning:** Raspberry Pi 5 (and most NAS ARM boxes) is `linux/arm64`. Building on a PC without `--platform linux/arm64` produces an amd64 image. Arcane then fails at start with `exec /usr/local/bin/docker-entrypoint.sh: exec format error`. Rebuild for arm64, save, and re-upload.

1. On a machine with Docker and this repo. For a Pi 5 / Arcane ARM host:

```sh
# once per builder, if qemu is missing:
docker run --privileged --rm tonistiigi/binfmt --install arm64

docker build --platform linux/arm64 -t fitia-mcp:local .
docker save fitia-mcp:local | gzip > fitia-mcp-local-arm64.tar.gz
openssl rand -hex 32
```

For an amd64 host, drop `--platform` and name the tar `fitia-mcp-local.tar.gz`.

Confirm the saved image is arm64 before uploading:

```sh
docker image inspect fitia-mcp:local --format '{{.Os}}/{{.Architecture}}'
# expect: linux/arm64
```

2. In Arcane: **Subir imagen** → `fitia-mcp-local.tar.gz`. Confirm the imported tag is `fitia-mcp:local`.
3. New project: paste `docker-compose.yml` from this repo (it already uses `image: fitia-mcp:local` and no `build`).
4. Set project env `FITIA_MCP_TOKEN` to the hex value from step 1. If Arcane does not interpolate `${FITIA_MCP_TOKEN}`, replace that line in the YAML with the literal token before deploy.
5. Publish `8080` to the LAN only. Deploy.
6. Open `http://<arcane-host>:8080`, unlock with the token, then sign in to Fitia.
7. Confirm with:

```sh
curl -sI http://<arcane-host>:8080/health
curl -s -H "Authorization: Bearer $FITIA_MCP_TOKEN" http://<arcane-host>:8080/auth/status
```

Umbrel can run the same compose file. An `umbrel-app.yml` is out of scope here.

## Connect Poke / Cursor / a web MCP client directly

The self-host is itself a standard Streamable HTTP MCP server, so a client can skip the mcp-proxy and use `FITIA_MCP_TOKEN` as its own API key. Nothing else has to hold the token.

| Setting | Value |
| --- | --- |
| URL | `http://<host>:48081/mcp` (or your published port) |
| Transport | streamable-http |
| Auth type | Bearer / API key |
| Key | `FITIA_MCP_TOKEN` |

Probing works without a key:

- `OPTIONS` preflights return `204` with CORS headers (no auth required).
- Unknown and `/.well-known/*` paths return `404` instead of `401`, so a client's discovery probe does not mistake the server for a non-MCP endpoint.
- `GET /health` is public.
- `POST /mcp` and `/auth/*` still require the bearer token.

If the client must go through mcp-proxy (for aggregation), the 401s come from the proxy's own `authTokens` gate: give the client that token. The proxy holds the downstream Fitia token in its config headers, so the client never sees it.

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
| `FITIA_MCP_TOKEN` | empty | Empty = open mode (auth by the fronting proxy). Set = local bearer on every route except `/health`. |

An empty `FITIA_MCP_TOKEN` disables the local bearer check, so the container must be LAN-only or behind a proxy that enforces auth.

## Volume

`session.json` is version 1: `idToken`, `refreshToken`, `uid`, `email`. The process writes it atomically (`session.json.tmp` then rename) with mode `0600`. Treat the volume as credentials.

If the container user cannot write the mount, fix ownership of the named volume rather than running as root.
