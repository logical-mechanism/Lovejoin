# Lovejoin deploy guide

This guide is the operator's reference for shipping the Lovejoin UI +
backend to **DigitalOcean App Platform**. The protocol itself is a
hyperstructure — once bootstrapped on a network it lives on chain
forever — so what we deploy here is the *frontend* (UI + indexer/API),
not the protocol.

The committed [`.do/app.yaml`](../.do/app.yaml) is the live Preprod
spec. [`.do/deploy.template.yaml`](../.do/deploy.template.yaml) is a
placeholder version for spinning up your own copy or adding a mainnet
variant after the audit gate.

> **Mainnet caveat.** Don't deploy to mainnet until M7 has tagged a
> real release and the protocol has cleared the audit gate
> (docs/spec/11-open-questions.md OQ-Y). The bootstrap ceremony is
> irreversible per network.

## Architecture

A single DO App, two services, one shared domain:

```
        ┌──────────────────────────────────────────────────────┐
        │  ${APP_URL}  (lovejoin-preprod.ondigitalocean.app)   │
        ├──────────────────────────────────────────────────────┤
        │  /api/*  ──►  backend (Fastify, port 3001)           │
        │     │                                                │
        │     └─►  prefix stripped by DO ──►  /pool, /health…  │
        │                                                      │
        │  /*      ──►  ui (nginx, port 8080)                  │
        │              try_files $uri /index.html              │
        └──────────────────────────────────────────────────────┘
                              │
                              │ wss + postgres
                              ▼
            external:  Ogmios + (optional) db-sync postgres
```

DO's path-stripping means Fastify's routes stay at their canonical
top-level paths (`/health`, `/pool`, `/params`, etc. — see
[`backend/src/api/server.ts`](../backend/src/api/server.ts)). The
`/api` prefix lives only in the route map.

## External services Lovejoin needs

DO App Platform can't run a Cardano node, so the backend points at
external infrastructure for chain access:

| Service | Required? | Used for | Suggested provider |
| --- | --- | --- | --- |
| Ogmios (WebSocket) | **yes** | Chainsync (indexer), tx submission, tx evaluation | [Demeter](https://demeter.run/), [DRI](https://dri.io/), self-hosted via Cloudflare Tunnel |
| db-sync (Postgres) | optional | `/history/:address`, `/utxos/:address`, `/tx/:hash` | [Demeter](https://demeter.run/) postgres extension, or your own |
| Blockfrost (HTTPS) | optional | Fallback for `/history` when db-sync is down or absent | [blockfrost.io](https://blockfrost.io/) (free tier covers Preprod) |

Without Ogmios the backend won't start (the indexer needs chainsync).
Without db-sync the address-keyed routes 503 — set
`BLOCKFROST_PROJECT_ID_<NETWORK>` to keep `/history` working; the SDK
+ UI fall back to `BlockfrostProvider` for `/utxos` + `/tx`-style
queries.

## Connecting App Platform to home-hosted infrastructure

DO App Platform's outbound IP is **not stable** on the basic plan —
your service shares a NAT pool whose addresses rotate, so a UFW
allowlist on a home server has no fixed target to whitelist. The
options, ordered by what we use:

### 1. Cloudflare Tunnel (recommended, free)

`cloudflared` runs on the home box and dials *outbound* to Cloudflare;
Cloudflare exposes `ogmios.yourdomain` as a public hostname. No
inbound port at home, no DDNS, no allowlist, TLS handled by CF. The
tradeoff is a hard split between protocols:

| Protocol | Works via CF Tunnel public hostname? | Notes |
| --- | --- | --- |
| Ogmios (HTTP/WS) | **yes** | `service: http://localhost:1337`; CF forwards `Upgrade: websocket` cleanly. |
| Postgres (raw TCP) | **no** | Public hostnames are HTTP/HTTPS/WS only. TCP routes need `cloudflared access tcp` on the *consuming* side, which App Platform basic can't run as a sidecar. |

So the alpha shape is **Ogmios via CF Tunnel + db-sync skipped**
(Blockfrost fallback covers `/history`; the rest of the
db-sync-backed routes 503 and the SDK falls through to direct
Blockfrost queries). Add db-sync back later via one of the heavier
options below.

#### One-time home setup

```bash
# 1. Install on the home server (Linux example; see CF docs for other OSes)
sudo apt install cloudflared

# 2. Authenticate against your CF zone
cloudflared tunnel login           # opens browser, picks the zone

# 3. Create a named tunnel
cloudflared tunnel create lovejoin-preprod

# 4. Route a hostname to it
cloudflared tunnel route dns lovejoin-preprod ogmios-preprod.yourdomain.com

# 5. Configure ingress
cat > ~/.cloudflared/config.yml <<'YAML'
tunnel: <UUID-from-step-3>
credentials-file: /home/<you>/.cloudflared/<UUID>.json
ingress:
  - hostname: ogmios-preprod.yourdomain.com
    service: http://localhost:1337
  - service: http_status:404
YAML

# 6. Run as a systemd service
sudo cloudflared service install
sudo systemctl enable --now cloudflared

# 7. Verify from anywhere on the internet
curl -I https://ogmios-preprod.yourdomain.com/health
```

Then in App Platform, set `OGMIOS_URL=wss://ogmios-preprod.yourdomain.com`
on the backend service. UFW on the home box keeps Ogmios's listener
bound to 127.0.0.1 — no public port, no allowlist needed.

#### Adding db-sync to a Cloudflare Tunnel setup (advanced)

If you want db-sync without buying a Droplet, two paths:

1. **`cloudflared access tcp` baked into the backend image.** Modify
   `backend/Dockerfile` to install `cloudflared`, add an entrypoint
   that runs `cloudflared access tcp --hostname dbsync.yourdomain
   --url 127.0.0.1:5432 &` before `node dist/index.js`, and set
   `DBSYNC_URL=postgres://user:pass@127.0.0.1:5432/db`. Requires a
   Cloudflare Access service token (set as a SECRET env on the App
   Platform side). Not on the M7 path; document if/when we need it.
2. **HTTP wrapper at home.** Run `postgrest` (or similar) at home
   exposing the dbsync schema over HTTPS, route via CF Tunnel like
   Ogmios, and write a small adapter on the backend that translates
   the `DbSyncClient` interface to postgrest queries. More code; less
   Docker surgery.

Both are deferred — neither blocks the alpha.

### 2. Tiny DO Droplet as a fixed-IP jump host

A $4/mo Droplet with a Reserved IP, reverse-SSH-tunnel from home to
the Droplet, expose Ogmios + Postgres on the Droplet's public side,
UFW-allow only the Droplet's IP at home. More moving parts than CF
Tunnel; only worth it if you really want db-sync without the
adapter work.

### 3. App Platform Pro + Dedicated Egress IPs (paid)

The "just pay DO" answer. Pro plan + the Dedicated Egress IP add-on
gives App Platform a stable outbound IP you can UFW-allow. Probably
premature for a one-maintainer alpha; revisit at mainnet scale.

## Secrets handling

`.do/app.yaml` is committed to a public repo, so **no real secret
values live in it**. SECRET-typed env vars carry placeholders
(`value: EDIT_ME` for `OGMIOS_URL`, `value: ""` for the optional
ones); the real values are managed in DO. Two patterns work:

### A. Manage in the DO dashboard (simplest, recommended)

1. `make do-deploy` once with the placeholder spec. The container
   will boot, fail to connect to Ogmios, and `/health` will 503 —
   that's expected.
2. In the DO dashboard → your app → Settings → App-Level Environment
   Variables (or per-component), edit each `type: SECRET` variable
   and paste the real value. Save.
3. DO triggers a redeploy; the indexer connects, `/health` flips to
   200.

DO **preserves dashboard-set SECRET values across spec updates** as
long as the spec keeps the placeholder. So `make do-update
APP_ID=…` is safe to run repeatedly without clobbering secrets.
This is what we recommend for the Preprod alpha.

### B. Keep a local spec with real values

For ops scripts that need to be reproducible, drop a copy at
`.do/app.local.yaml` with real values filled in. The repo's
`.gitignore` excludes `.do/*.local.yaml`. Apply with:

```bash
APP_SPEC=.do/app.local.yaml make do-update APP_ID=<uuid>
```

If you go this route, treat the file like a credential — keep it out
of cloud sync, shared dotfiles, etc.

### What's safe to commit

- Plaintext URLs without embedded tokens (e.g.
  `wss://ogmios-preprod.yourdomain.com` if the auth is at the CF
  Access layer, not in the URL).
- `${APP_URL}` interpolations.
- All `scope: BUILD_TIME` UI envs *except* tokens — but remember
  build-time UI envs end up in the bundle anyway (see "UI build-time
  secrets" below), so a free-tier Blockfrost project ID is fine
  there even though it's marked SECRET.

### What must never be committed

- Demeter / DRI URLs that include a token query param.
- Postgres connection strings with passwords.
- Any paid-tier Blockfrost project ID.

## Environment variable matrix

### Backend (runtime — read by `backend/src/config.ts`)

| Var | Required | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `NETWORK` | yes | plaintext | `preprod` | Must match the `NETWORK` build-arg used to bake `addresses.json`. |
| `PORT` | yes | plaintext | `3001` | Fastify listens here. DO health-checks the same port. |
| `HOST` | no | plaintext | `0.0.0.0` | Container-friendly default; do not set `127.0.0.1`. |
| `OGMIOS_URL` | yes | **secret** | – | `wss://ogmios.example/<token>`. Indexer + `/submit` + `/evaluate`. |
| `DBSYNC_URL` | no | **secret** | – | `postgres://user:pass@host/db`. Set to enable address-keyed routes. |
| `BLOCKFROST_PROJECT_ID_PREPROD` | no | **secret** | – | History fallback when db-sync is down. Suffix matches the network. |
| `BLOCKFROST_BASE_URL` | no | plaintext | per-network public Blockfrost | Override only if you proxy. |
| `ADDRESSES_PATH` | no | plaintext | `/srv/lovejoin/addresses.json` | Matches the `COPY` in `backend/Dockerfile`. |
| `CORS_ORIGINS` | yes | plaintext | – | Comma-separated allowlist; `${APP_URL}` works on DO. `*` allows all. |
| `RATE_LIMIT_PER_MIN` | no | plaintext | `600` | Per-IP rate limit on every Fastify route. |
| `BOOTSTRAP_START_SLOT` | no | plaintext | `addresses.bootstrapStartPoint.slot` | Override the chainsync intersection. |
| `BOOTSTRAP_START_BLOCKHASH` | no | plaintext | `addresses.bootstrapStartPoint.blockHash` | Required iff `BOOTSTRAP_START_SLOT` is set. |

### UI (build-time — read by Vite from the workspace `.env`)

> **Build-time = baked into the static bundle.** Each environment
> (preprod vs mainnet) needs its **own image build** with its own
> `VITE_*` values. There is no runtime way to swap them — the values
> become string literals in `dist/assets/*.js`.

| Var | Required | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `VITE_NETWORK` | yes | plaintext | `preprod` | Drives the SDK's per-network code paths. |
| `VITE_BACKEND_URL` | yes | plaintext | `http://localhost:3001` | Full URL incl. scheme. On DO use `${APP_URL}/api` so the same hostname serves both UI + backend. |
| `VITE_BLOCKFROST_PROJECT_ID` | no | **secret-ish** | – | Optional client-side Blockfrost fallback. See "UI build-time secrets". |
| `VITE_COLLATERAL_ENDPOINT` | no | plaintext | SDK per-network default | Override only when proxying or testing locally. |

#### UI build-time secrets

Anything passed as `VITE_*` ends up in the JavaScript bundle that ships
to every browser — *that includes secrets you mark as `type: SECRET`
in the App spec*. The `SECRET` flag only masks the value in the DO
spec audit log + dashboard; the resulting bundle is still
human-readable. Implications:

- **Never put a write-scoped or paid-tier API key in `VITE_*`.** A
  free-tier Blockfrost project ID is the right shape — readers can
  scrape it from the bundle either way.
- The collateral provider endpoint is non-sensitive (it's a public
  HTTPS host); leaving it as plaintext is fine.
- The backend's `OGMIOS_URL` and `DBSYNC_URL` *are* secrets and live
  in the **runtime** envs of the backend service — they never reach
  the UI bundle.

## Local sanity check before deploy

Both Dockerfiles build with the repo root as context:

```bash
make docker-build-backend NETWORK=preprod
make docker-build-ui NETWORK=preprod \
  BACKEND_URL=https://lovejoin-preprod.ondigitalocean.app/api \
  BLOCKFROST=mainnetXXXXXXXXXXXXXXXXXXXXXXXX
```

Both should exit 0 without trying to start the runtime. (You can't
fully exercise the backend image without an Ogmios endpoint to point
it at; the build passing is the deploy-readiness signal.)

## First-time deploy

1. **Authenticate doctl** (one-time per workstation):
   ```bash
   sudo snap install doctl     # or `brew install doctl`
   doctl auth init             # paste a personal access token
   ```

2. **Edit `.do/app.yaml`**:
   - Replace the `EDIT_ME` `OGMIOS_URL` with your real wss URL.
   - Optionally set `DBSYNC_URL`, `BLOCKFROST_PROJECT_ID_PREPROD`, and
     `VITE_BLOCKFROST_PROJECT_ID`.
   - Adjust `region:` if NYC isn't where you want it.

3. **Apply**:
   ```bash
   make do-deploy
   ```
   `doctl` returns the new app's UUID and a build URL. The first build
   takes 5–10 minutes; subsequent pushes to `main` redeploy
   automatically (`deploy_on_push: true`).

4. **Smoke test** once the app reports as `ACTIVE`:
   ```bash
   APP_URL=https://lovejoin-preprod-XXXX.ondigitalocean.app
   curl -fsS "$APP_URL/api/health" | jq
   curl -fsS "$APP_URL/api/params" | jq
   curl -fsSI "$APP_URL/" | head -3
   ```

   `/api/health` should return `{ "ok": true, … }` once the indexer
   has caught up. During initial sync `lagSeconds` will be high; that's
   expected.

## Updating the deploy

- **Code changes** that should ship: push to `main`. DO rebuilds and
  rolls automatically.
- **App-spec edits** (env vars, routes, instance size): commit to
  `main`, then run `make do-update APP_ID=<uuid>`. The push hook only
  re-runs the build pipeline; spec changes need an explicit update.
- **Rollback**: `doctl apps list-deployments <app-id>` shows past
  builds; `doctl apps create-deployment <app-id> --rebuild` re-runs
  the latest build.

## Per-network deploys (preprod vs mainnet)

UI env vars are baked at build time, so each network needs its own
build. Two patterns work:

1. **Two App specs, two apps.** Copy `.do/deploy.template.yaml` to
   `.do/app.mainnet.yaml`, fill in mainnet placeholders, and apply with
   `APP_SPEC=.do/app.mainnet.yaml make do-deploy`. Each app gets its
   own DO domain. This is the recommended setup once mainnet is live.

2. **DO Environments feature.** App Platform supports per-environment
   overrides on a single spec. We don't use this today because the
   UI's `VITE_NETWORK` controls SDK code paths and a botched override
   would silently mix mainnet UI with preprod backend. Two-spec
   isolation is safer.

## Health checks + auto-restart

`backend/src/api/server.ts:registerHealth` returns:

- `200 OK` (with `ok: true`) — indexer healthy, optionally caught up.
- `200 OK` (with `ok: false`) — reference UTxO alarm fired. **Do not
  restart**: this is an on-chain anomaly that a fresh process won't
  fix; an operator needs to look at it.
- `503 Service Unavailable` — indexer runtime has a fatal error. DO
  restarts the container after `failure_threshold` consecutive failures
  (default 3 × 30 s = ~90 s).

The UI's nginx serves `/index.html` on `/` so DO health-checks the
root path as a static-asset probe.

## Rate limiting + privacy

The backend's `@fastify/rate-limit` keys per IP; `RATE_LIMIT_PER_MIN`
sets the cap. Per [`docs/spec/06-ui.md`](spec/06-ui.md) §"Privacy UX
rules" the backend logs IPs only for rate limiting and retains them
for less than 24 h. The UI nginx's `access_log` is **off** so IPs
never reach disk on the frontend tier.

## Things deliberately not in scope

- Container registries, CDNs, custom worker pools — DO App Platform
  bundles all of that.
- A staging environment — Preprod *is* staging until mainnet is live
  (post-audit).
- Horizontal scaling — `instance_count: 1` is fine for the alpha.
  Bumping it requires sticky sessions or moving the indexer state to
  Redis/Postgres; that's a future-M milestone, not a deploy concern.
- Backups of `addresses.json` — it's reproducible from the bootstrap
  ceremony's on-chain artifacts; the file in `artifacts/preprod/` is
  the canonical copy and lives in Git.

## See also

- [`backend/Dockerfile`](../backend/Dockerfile) — runtime image.
- [`ui/Dockerfile`](../ui/Dockerfile) + [`ui/nginx.conf`](../ui/nginx.conf) — static-bundle image.
- [`.do/app.yaml`](../.do/app.yaml) — committed App spec for Preprod.
- [`docs/spec/05-backend.md`](spec/05-backend.md) — backend API surface.
- [`docs/spec/06-ui.md`](spec/06-ui.md) — UI screens, privacy rules,
  config model.
