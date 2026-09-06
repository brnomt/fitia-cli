#!/usr/bin/env bun
import { fileStore, sessionCredentials } from "@fitia/core";
import { createServer } from "@fitia/mcp/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createSelfhostApp } from "./app.ts";

const timeoutMs = Number(process.env.FITIA_TIMEOUT_MS ?? 15_000);
const boundedTimeout =
  Number.isSafeInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 120_000 ? timeoutMs : 15_000;
const store = fileStore();
const mcpToken = process.env.FITIA_MCP_TOKEN ?? "";

if ((process.env.FITIA_TRANSPORT ?? "http") === "stdio") {
  serveStdio(() =>
    createServer({
      timeoutMs: boundedTimeout,
      getCredentials: () => sessionCredentials(store, true),
    }),
  );
} else {
  const port = Number(process.env.FITIA_PORT ?? 8080);
  const hostname = process.env.FITIA_HOST ?? "0.0.0.0";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    process.stderr.write("FITIA_PORT must be an integer from 1 to 65535.\n");
    process.exit(1);
  }
  const app = createSelfhostApp({ store, mcpToken, timeoutMs: boundedTimeout });
  const runtime = globalThis as typeof globalThis & {
    Bun: { serve: (options: { port: number; hostname: string; fetch: typeof app.fetch }) => unknown };
  };
  runtime.Bun.serve({ port, hostname, fetch: app.fetch });
  process.stderr.write(`Fitia self-host listening on http://${hostname}:${port}\n`);
}
