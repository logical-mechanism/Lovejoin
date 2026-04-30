# syntax=docker/dockerfile:1.6
#
# Lovejoin backend image.
#
# Multi-stage build:
#   1. `deps` stage prefetches dependencies in a deterministic pnpm
#      install pinned by the workspace lockfile.
#   2. `build` stage compiles TypeScript to dist/.
#   3. `runtime` stage ships only the compiled output + production deps.
#
# Build context: the *repository root* (so the workspace lockfile + the
# offchain / shared paths resolve). Build with:
#
#   docker build -f backend/Dockerfile -t lovejoin-backend .
#
# Build args:
#
#   NETWORK=preprod (default) | test | mainnet
#     Selects which artifacts/<NETWORK>/addresses.json gets baked into
#     the image at /srv/lovejoin/addresses.json. addresses.json is the
#     output of the one-shot bootstrap ceremony and is static for the
#     lifetime of a deployment — so baking it in is the right call.
#     Override at build time:  --build-arg NETWORK=mainnet
#
# Runtime config — every value the entrypoint reads from env:
#
#   NETWORK=preprod | mainnet | preview
#   PORT=3001
#   HOST=0.0.0.0
#   OGMIOS_URL=ws://ogmios:1337
#   DBSYNC_URL=postgres://USER:PASS@HOST/db        (optional)
#   BLOCKFROST_PROJECT_ID_PREPROD=…                (optional fallback)
#   ADDRESSES_PATH=/srv/lovejoin/addresses.json    (default; matches the COPY below)
#   CORS_ORIGINS=https://lovejoin.example,https://…
#   RATE_LIMIT_PER_MIN=600
#
# Cloudflare Tunnel sidecar — set any of these to run `cloudflared
# access tcp` inside the container before the node process starts, so
# the backend can reach a home-hosted Ogmios / db-sync without
# inbound ports or a stable App Platform egress IP. See
# docs/deploy.md §"Connecting App Platform to home-hosted infrastructure".
#
#   CF_TUNNEL_OGMIOS_HOSTNAME=ogmios-preprod.example.com
#       Hostname configured in Cloudflare Access. When set, the
#       entrypoint relays it to 127.0.0.1:1337 — point OGMIOS_URL at
#       ws://127.0.0.1:1337. When unset, the entrypoint skips the
#       tunnel and OGMIOS_URL must be a directly-reachable URL.
#   CF_TUNNEL_DBSYNC_HOSTNAME=dbsync-preprod.example.com
#       Same idea, relayed to 127.0.0.1:5432; point DBSYNC_URL at
#       postgres://USER:PASS@127.0.0.1:5432/DBNAME.
#   CF_TUNNEL_SERVICE_TOKEN_ID=…
#   CF_TUNNEL_SERVICE_TOKEN_SECRET=…
#       Cloudflare Access service token; required if either tunnel
#       hostname is behind an Access policy (recommended).

ARG NODE_VERSION=22-alpine
ARG NETWORK=preprod

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Copy only the files needed to resolve dependencies. Any change in
# source code below this layer doesn't bust the install cache.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json backend/
COPY offchain/package.json offchain/
COPY ui/package.json ui/
COPY stress-tests/package.json stress-tests/
COPY integration-tests/package.json integration-tests/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @lovejoin/backend...

FROM deps AS build
WORKDIR /app
COPY backend backend
RUN pnpm --filter @lovejoin/backend build

# ---------------------------------------------------------------------
# cloudflared — pulled in a throwaway stage so the runtime image only
# carries the static binary, not the curl tooling used to fetch it.
# Pinned via CLOUDFLARED_VERSION; bump deliberately (Cloudflare ships
# the same binary for years, so this rarely needs touching).
# ---------------------------------------------------------------------
FROM alpine:3.20 AS cloudflared-source
ARG CLOUDFLARED_VERSION=2025.11.0
RUN apk add --no-cache curl ca-certificates && \
    arch=$(uname -m) && \
    case "$arch" in \
      x86_64)  url="cloudflared-linux-amd64" ;; \
      aarch64) url="cloudflared-linux-arm64" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac && \
    curl -fsSL \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${url}" \
      -o /cloudflared && \
    chmod +x /cloudflared && \
    /cloudflared --version

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Reinstall production-only deps for the backend (smaller image, no
# dev tooling like vitest / typescript).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json backend/
COPY offchain/package.json offchain/
COPY ui/package.json ui/
COPY stress-tests/package.json stress-tests/
COPY integration-tests/package.json integration-tests/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @lovejoin/backend...

# Compiled JS from the build stage.
COPY --from=build /app/backend/dist backend/dist

# Bake the bootstrap-produced addresses.json into the image. The path
# matches the default `ADDRESSES_PATH` so no env wiring is needed at
# deploy time. Switch networks with `--build-arg NETWORK=…`.
ARG NETWORK
COPY artifacts/${NETWORK}/addresses.json /srv/lovejoin/addresses.json

# Cloudflare Tunnel sidecar tooling.
#  - tini: PID 1 init that forwards SIGTERM to the whole process group
#    so cloudflared + node both shut down cleanly when DO restarts the
#    container. `-g` propagates signals to the entrypoint's process
#    group rather than just its direct child.
#  - cloudflared: the static binary fetched in the throwaway stage above.
#  - entrypoint.sh: starts cloudflared access tcp for whichever
#    CF_TUNNEL_*_HOSTNAME env vars are set, waits for the local
#    listeners to come up, then exec's node.
RUN apk add --no-cache tini
COPY --from=cloudflared-source /cloudflared /usr/local/bin/cloudflared
COPY backend/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node
EXPOSE 3001
WORKDIR /app/backend
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]
