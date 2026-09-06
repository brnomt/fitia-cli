# syntax=docker/dockerfile:1
# Stage 1: install the workspace and emit a single Bun bundle. CLI/Worker stay out of the image.
FROM oven/bun:1.3-alpine AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/selfhost/package.json apps/selfhost/package.json
COPY apps/cli/package.json apps/cli/package.json
RUN bun install --frozen-lockfile
COPY packages/core packages/core
COPY apps/mcp apps/mcp
COPY apps/selfhost apps/selfhost
RUN bun build apps/selfhost/src/index.ts --outfile /out/server.js --target bun --minify --sourcemap=none

# Stage 2: non-root runtime with a persistent session volume.
FROM oven/bun:1.3-alpine
WORKDIR /app
RUN addgroup -S fitia && adduser -S -G fitia fitia \
  && mkdir -p /app/data && chown -R fitia:fitia /app
COPY --from=build /out/server.js /app/server.js
USER fitia
ENV FITIA_DATA_DIR=/app/data \
    FITIA_PORT=8080 \
    FITIA_HOST=0.0.0.0 \
    FITIA_TRANSPORT=http \
    NODE_ENV=production
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.FITIA_PORT||'8080')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "/app/server.js"]
