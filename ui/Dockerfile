# syntax=docker/dockerfile:1.6
#
# Lovejoin UI image.
#
# Multi-stage build:
#   1. `deps` stage prefetches workspace dependencies for @lovejoin/ui.
#   2. `build` stage builds @lovejoin/sdk first (UI imports it via
#      workspace:* and the dist/ tree must exist before tsc resolves it),
#      then runs `vite build` to produce ui/dist/.
#   3. `runtime` stage is nginx:alpine serving the static dist/ with
#      SPA-friendly routing (try_files → /index.html for React Router).
#
# Build context: the *repository root* (the workspace lockfile lives
# there and the SDK build needs offchain/). Build with:
#
#   docker build -f ui/Dockerfile -t lovejoin-ui .
#
# Build args (every VITE_* env that the UI reads at build time — these
# are baked into the static bundle, so you must rebuild to change them):
#
#   VITE_NETWORK=preprod | preview | mainnet      (default: preprod)
#   VITE_BACKEND_URL=https://lovejoin.example/api (no default — UI falls
#                                                  back to localhost:3001
#                                                  if unset)
#   VITE_BLOCKFROST_PROJECT_ID=…                  (optional fallback)
#   VITE_COLLATERAL_ENDPOINT=…                    (optional override)
#
# Runtime config — nginx itself reads these:
#
#   PORT=8080  (DigitalOcean App Platform injects this; we listen on it)

ARG NODE_VERSION=22-alpine
ARG NGINX_VERSION=1.27-alpine

# ---------------------------------------------------------------------
# deps — pnpm install for the UI, restricted to the workspace closure
# the UI actually needs (UI + transitive @lovejoin/sdk).
# ---------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Mirror the backend Dockerfile's workspace bootstrap: copy every
# package.json so pnpm can resolve workspace:* without the source files
# present yet. This keeps the install layer cache-friendly across UI
# source edits.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json backend/
COPY offchain/package.json offchain/
COPY ui/package.json ui/
COPY stress-tests/package.json stress-tests/
COPY integration-tests/package.json integration-tests/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @lovejoin/ui...

# ---------------------------------------------------------------------
# build — build the SDK first, then vite-build the UI.
# ---------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

# UI imports @lovejoin/sdk by its built dist/. Build the SDK first so
# the UI's tsc resolves the type imports and vite finds the runtime
# entry. Mirrors `.github/workflows/ci.yml` ordering.
COPY offchain offchain
RUN pnpm --filter @lovejoin/sdk run build

COPY ui ui

# Whitepaper PDFs live at the workspace root; the UI's `pnpm build`
# script copies them into ui/public/papers/ so vite emits them under
# /papers/*.pdf. Without this COPY the build script fails because
# the source files don't exist in the Docker context.
COPY papers papers

# Vite reads .env from the workspace root (ui/vite.config.ts envDir:
# ".."). On a fresh build context there is no .env file, so all VITE_*
# values must come from the build environment. Re-declare each ARG
# here (multi-stage scope) and re-export as ENV so vite picks them up.
ARG VITE_NETWORK=preprod
ARG VITE_BACKEND_URL
ARG VITE_BLOCKFROST_PROJECT_ID
ARG VITE_COLLATERAL_ENDPOINT
ENV VITE_NETWORK=${VITE_NETWORK}
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}
ENV VITE_BLOCKFROST_PROJECT_ID=${VITE_BLOCKFROST_PROJECT_ID}
ENV VITE_COLLATERAL_ENDPOINT=${VITE_COLLATERAL_ENDPOINT}

RUN pnpm --filter @lovejoin/ui run build

# ---------------------------------------------------------------------
# runtime — nginx:alpine serving ui/dist with SPA fallback.
# ---------------------------------------------------------------------
FROM nginx:${NGINX_VERSION} AS runtime

# Strip the default site so our config is the only one in conf.d/.
RUN rm -f /etc/nginx/conf.d/default.conf

COPY ui/nginx.conf /etc/nginx/templates/default.conf.template

# Static assets. nginx reads them from /usr/share/nginx/html.
COPY --from=build /app/ui/dist /usr/share/nginx/html

# DO App Platform requires the service to listen on $PORT (typically
# 8080). nginx:alpine has an envsubst entrypoint that templates
# /etc/nginx/templates/*.template into /etc/nginx/conf.d/ at startup
# using $PORT (and any other vars listed in NGINX_ENVSUBST_TEMPLATE_*).
ENV PORT=8080
EXPOSE 8080
