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

USER node
EXPOSE 3001
WORKDIR /app/backend
CMD ["node", "dist/index.js"]
