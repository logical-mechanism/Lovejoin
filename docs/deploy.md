# Lovejoin deploy guide

This guide is the operator's reference for shipping the Lovejoin UI +
backend to **DigitalOcean App Platform**. The protocol itself is a
hyperstructure — once bootstrapped on a network it lives on chain
forever — so what we deploy here is the _frontend_ (UI + indexer/API),
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

| Service            | Required? | Used for                                                   | Suggested provider                                                                         |
| ------------------ | --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Ogmios (WebSocket) | **yes**   | Chainsync (indexer), tx submission, tx evaluation          | [Demeter](https://demeter.run/), [DRI](https://dri.io/), self-hosted via Cloudflare Tunnel |
| db-sync (Postgres) | optional  | Cold-start prime + reprime, `/tx/:hash`, `/tx/:hash/utxos` | [Demeter](https://demeter.run/) postgres extension, or your own                            |

Without Ogmios the backend won't start (the indexer needs chainsync).
Without db-sync the backend still comes up but the cold-start prime
falls back to a chainsync replay from `bootstrapStartPoint`; tx-hash
lookup routes (`/tx/:hash`, `/tx/:hash/utxos`) return 503.

### db-sync configuration for the cold-start prime

The indexer's cold-start prime (issue #87) bulk-loads live mix-box
UTxOs and fee shards from db-sync at its latest stable block, then
resumes chainsync from there. The default query shape uses a
`NOT EXISTS` subquery against `tx_in` to filter live outputs; that
walks O(historical tx_outs at the address). For a low-traffic
deployment (Preprod alpha) it runs in well under a second. For a
heavily-used pool with millions of cumulative deposits + mixes it can
exceed the backend's per-query timeout.

**Recommended db-sync flags** (db-sync 13.1+) — set these in the
db-sync config (typically `config/<network>-config.yaml`, e.g.
`preprod-config.yaml` or `mainnet-config.yaml` in the cardano-db-sync
checkout) so the prime can use a single column compare instead of a
subquery. The minimal additions to a typical `insert_options` block:

```yaml
insert_options:
  tx_cbor: enable # whatever you already have
  tx_out:
    value: enable # required for prime: lovelace amount
    use_address: true # ADD: indexes tx_out.address for fast lookup
  consumed_tx_out: enable # ADD: populates tx_out.consumed_by_tx_id
  multi_asset:
    enable: true # required for prime: reference NFT lookup
  # ... rest of your insert_options unchanged
```

What each flag does:

- `tx_out.value: enable` — populates the lovelace value column. The
  prime queries select it. Almost certainly already on.
- `tx_out.use_address: true` — adds an index on `tx_out.address` so
  address-scoped lookups don't have to join through `tx`.
- `consumed_tx_out: enable` — populates `tx_out.consumed_by_tx_id`
  inline whenever an output is spent. The backend probes for this
  column at startup; if present, the prime query becomes
  `WHERE tx_out.address = $1 AND tx_out.consumed_by_tx_id IS NULL`,
  which is O(live UTxO count) regardless of historical depth.
- `multi_asset.enable: true` — populates `ma_tx_out` + `multi_asset`.
  Required for the reference-NFT lookup. Almost certainly already on.

**Backfill (one-time, mandatory if you enable `consumed_tx_out` on an
existing db-sync database)** — the column is populated only for
outputs created after the flag is enabled; pre-existing spent outputs
read as `NULL` (looking live) until you backfill. Skipping it is
silent corruption: the backend will return historically-spent outputs
as live and the indexer's pool view will disagree with the chain.

The migration ships with db-sync as a numbered SQL file. Recent
versions auto-run it on startup once the flag is flipped — check
db-sync's startup logs for a `migration-4-NNNN-consumed-by-tx-id*`
line. If your version doesn't auto-run it, find the script and run
it manually:

```bash
# Source build: schema/ directory in the cardano-db-sync checkout
ls schema/migration-4-*consumed*

# Docker / package install: typically under
ls /usr/local/share/cardano-db-sync/schema/migration-4-*consumed*

# Then apply against the running db-sync database
psql "$DBSYNC_URL" -f /path/to/migration-4-NNNN-consumed-by-tx-id.sql
```

On Preprod the backfill is fast (small chain). On mainnet it walks
every spent `tx_out` and is significantly heavier — plan a maintenance
window, or build a fresh db-sync from scratch with the flag already
on instead of migrating in place.

**Verify the column is populated** — directly against postgres:

```sql
SELECT COUNT(*) FROM tx_out WHERE consumed_by_tx_id IS NULL;
```

After the backfill that count should match the network's live UTxO
count, not the cumulative tx_out total. If it's the cumulative total,
the backfill didn't run and the backend will misreport state.

**Verifying the fast path is engaged** — after redeploying the backend
against a flagged db-sync, hit `/health` and check
`indexerOrigin.source === "primed"` (vs `"replayed"`, which means the
prime fell back to legacy chainsync replay). The backend logs
`prime: query path = consumed_by_tx_id` (fast) or
`prime: query path = NOT EXISTS (legacy)` at startup, so you can
confirm the column probe picked the right shape.

**If you can't enable the flag** (managed db-sync without config
access), the legacy `NOT EXISTS` path keeps working. Watch the prime
timing log; if it approaches the per-query cap, switch to a provider
that exposes the column or pin `INDEXER_COLD_START=replay` to skip
the prime entirely (the runtime walks forward from
`bootstrapStartPoint` instead).

## Connecting App Platform to home-hosted infrastructure

DO App Platform's outbound IP is **not stable** on the basic plan —
your service shares a NAT pool whose addresses rotate, so a UFW
allowlist on a home server has no fixed target to whitelist. The
options, ordered by what we use:

### 1. Cloudflare Tunnel + Cloudflare Access (recommended, free)

`cloudflared` runs on the home box and dials _outbound_ to Cloudflare,
which exposes the services on hostnames you control. No inbound port
at home, no DDNS, no allowlist, TLS handled by CF. Two transport modes
matter:

| Mode                            | Works for         | How the consumer reaches it                               | Used here for                          |
| ------------------------------- | ----------------- | --------------------------------------------------------- | -------------------------------------- |
| Public hostname (HTTP/HTTPS/WS) | Ogmios            | Plain HTTPS/WSS to the public hostname                    | Optional alternative for Ogmios        |
| Cloudflare Access (TCP)         | Ogmios + Postgres | A `cloudflared access tcp` client opens a local TCP relay | **Both** Ogmios + db-sync in our setup |

We use the **Access TCP path for both Ogmios and db-sync**: it's the
only way Postgres works through CF Tunnel (raw TCP doesn't ride a
public hostname), and routing Ogmios the same way lets a single
service token authorize both. The backend container ships with a
`cloudflared` sidecar — see [`backend/entrypoint.sh`](../backend/entrypoint.sh)
and the Dockerfile's runtime stage — that opens `127.0.0.1:1337`
(Ogmios) and `127.0.0.1:5432` (Postgres) before `node dist/index.js`
starts.

#### Home-side setup (one-time)

Pick whichever flow fits — both produce the same tunnel + ingress.
For a **headless server**, the dashboard-managed flow is simplest
(no `tunnel login`, no local config file). For users comfortable
editing config on the server, the locally-managed flow is also
fine.

##### Option A — dashboard-managed (token, headless-friendly)

1. Cloudflare Zero Trust dashboard → **Networks → Tunnels → Create
   a tunnel**. Connector: _Cloudflared_. Name: `lovejoin-preprod`.
2. CF gives you a one-line install command for every common OS,
   embedding a JWT token. On the headless box:
   ```bash
   sudo cloudflared service install eyJh...<token>...
   ```
   That installs + starts the systemd service in one step. No
   `tunnel login`, no config.yml, no cert.pem.
3. Still in the dashboard, **Public Hostnames → Add a public
   hostname** twice — once for each:
   - `ogmios-preprod.yourdomain.com` → service `TCP` → URL `localhost:1337`
   - `dbsync-preprod.yourdomain.com` → service `TCP` → URL `localhost:5432`
4. The tunnel picks up the new hostnames within seconds; no service
   restart needed.

The tunnel's identity (token) lives in `/etc/cloudflared/...` on the
server; the ingress rules live in CF and are edited from the dashboard.

##### Option B — locally-managed (config.yml, also works headless)

```bash
# 1. Install on the home server (Linux example; see CF docs for other OSes)
sudo apt install cloudflared

# 2. Authenticate against your CF zone. On a headless box, cloudflared
#    can't open a browser — it prints the auth URL to stdout. Copy
#    the URL, open it on your laptop / phone, pick the zone. The
#    cert.pem is fetched by cloudflared on the server via a CF API
#    poll once you finish the browser auth.
cloudflared tunnel login

# 3. Create a named tunnel
cloudflared tunnel create lovejoin-preprod
# → prints the tunnel UUID; note it.

# 4. Route both hostnames to the same tunnel
cloudflared tunnel route dns lovejoin-preprod ogmios-preprod.yourdomain.com
cloudflared tunnel route dns lovejoin-preprod dbsync-preprod.yourdomain.com

# 5. Configure ingress — both services on the one tunnel
cat > ~/.cloudflared/config.yml <<'YAML'
tunnel: <UUID-from-step-3>
credentials-file: /home/<you>/.cloudflared/<UUID>.json
ingress:
  - hostname: ogmios-preprod.yourdomain.com
    service: tcp://localhost:1337
  - hostname: dbsync-preprod.yourdomain.com
    service: tcp://localhost:5432
  - service: http_status:404
YAML

# 6. Move the config + credentials to /etc/cloudflared/ before
#    installing the service. `sudo cloudflared service install` runs
#    as root and won't read your user's `~/.cloudflared/` (root's
#    `~` is /root). It looks in /etc/cloudflared/ instead.
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml /etc/cloudflared/
sudo cp ~/.cloudflared/*.json /etc/cloudflared/
sudo sed -i "s|$HOME/.cloudflared|/etc/cloudflared|g" /etc/cloudflared/config.yml

# 7. Run as a systemd service so it survives reboots
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared        # active (running)
```

Leave `~/.cloudflared/cert.pem` alone — it's used by your shell for
tunnel-management commands (`cloudflared tunnel route dns ...`,
`cloudflared tunnel info ...`). The daemon doesn't need it; the
tunnel-specific `<UUID>.json` is what authenticates the daemon as
this particular tunnel.

`tcp://` (rather than `http://`) is what lets the consumer side use
`cloudflared access tcp`. Both services stay bound to localhost on the
home box — UFW keeps doing its job; no inbound rule needed.

##### Ignore the "allow Cloudflare IPs at your origin" prompt

During CF onboarding you'll see a recommendation along the lines of:

> Only allow Cloudflare IP addresses at your origin. Update your origin
> server's firewall to block all incoming traffic that doesn't
> originate from Cloudflare.

**That recommendation does not apply to a tunnel setup.** It's for
users running a public-facing origin behind CF's reverse proxy, who
want to make sure attackers can't bypass the proxy by hitting the
origin's public IP directly. With Cloudflare Tunnel there is no
inbound traffic to the origin at all — `cloudflared` dials _outbound_
to CF and proxies traffic back through that outbound connection. So:

- Keep your existing UFW default-deny inbound posture.
- Bind Ogmios + Postgres to `127.0.0.1` (or your LAN-only interface)
  so they don't even listen on a public interface.
- Don't add allow-rules for any CF IP ranges. Outbound-443 is the only
  thing `cloudflared` needs, which is already allowed in any sane
  default config.

#### Cloudflare Access policy + service token

In the Cloudflare Zero Trust dashboard. **Order matters** — create
the service token first; CF won't let you save an Access policy with
an empty include rule, and the policy's service-token dropdown is
only populated by tokens that already exist.

1. **Access → Service Auth → Service Tokens → Create Service Token.**
   Name it `lovejoin-backend`; pick a duration (1 year is fine — you
   can rotate later). CF gives you a Client ID and a Client Secret.
   **Copy the secret immediately — CF only shows it once.**
2. **Access → Applications → Add an Application → Self-hosted.**
   Application domain: `ogmios-preprod.yourdomain.com`. On the policy
   page: action `Service Auth`, **Include → Service Token →
   `lovejoin-backend`** (the token you just created shows up in the
   dropdown). Save.
3. **Repeat step 2 for `dbsync-preprod.yourdomain.com`.**

Network-wise: every request that reaches `cloudflared` for those
hostnames must present `CF-Access-Client-Id` + `CF-Access-Client-Secret`
headers. The `cloudflared access tcp` client we run inside the
backend container does this automatically when it sees the
corresponding env vars.

#### App Platform side

Set these on the backend service (via DO dashboard or [.do/app.yaml](../.do/app.yaml)):

| Env var                          | Type       | Example                                         | Notes                                                                                  |
| -------------------------------- | ---------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `CF_TUNNEL_OGMIOS_HOSTNAME`      | plaintext  | `ogmios-preprod.yourdomain.com`                 | Empty = skip the Ogmios sidecar; `OGMIOS_URL` then has to be a directly-reachable URL. |
| `CF_TUNNEL_DBSYNC_HOSTNAME`      | plaintext  | `dbsync-preprod.yourdomain.com`                 | Empty = skip the db-sync sidecar.                                                      |
| `CF_TUNNEL_SERVICE_TOKEN_ID`     | **SECRET** | `<uuid>.access`                                 | Service-token Client ID from CF Zero Trust.                                            |
| `CF_TUNNEL_SERVICE_TOKEN_SECRET` | **SECRET** | (long opaque string)                            | Service-token Client Secret.                                                           |
| `OGMIOS_URL`                     | plaintext  | `ws://127.0.0.1:1337`                           | Loopback when the sidecar is in play.                                                  |
| `DBSYNC_URL`                     | **SECRET** | `postgres://user:pass@127.0.0.1:5432/cexplorer` | Loopback host; user/pass are the home-side Postgres creds.                             |

The committed `.do/app.yaml` already has these as placeholders;
filling them in via the DO dashboard is the path described under
"Secrets handling" below.

#### Verifying it works

After the first deploy with values filled in, watch the runtime logs:

```
entrypoint: starting cloudflared access tcp for ogmios (-> ogmios-preprod.yourdomain.com:1337)
entrypoint: cloudflared listener for ogmios ready on 127.0.0.1:1337
entrypoint: starting cloudflared access tcp for dbsync (-> dbsync-preprod.yourdomain.com:5432)
entrypoint: cloudflared listener for dbsync ready on 127.0.0.1:5432
```

Then `/api/health` should report `ok: true` once the indexer catches
up. If the listener doesn't come up after 30 s the entrypoint exits 1
(DO restarts the container); 99% of the time that means the service
token is wrong or the CF Access app for that hostname doesn't exist
yet.

#### Skipping the tunnel for one or both services

The entrypoint's tunnel logic is opt-in per service:

- Want Ogmios on a public CF hostname (no Access)? Configure the
  home-side ingress as `service: http://localhost:1337`, leave
  `CF_TUNNEL_OGMIOS_HOSTNAME` empty, and set `OGMIOS_URL=wss://ogmios-preprod.yourdomain.com`.
- Want managed Ogmios (Demeter, DRI)? Same idea — leave
  `CF_TUNNEL_OGMIOS_HOSTNAME` empty and put the provider URL in
  `OGMIOS_URL`.
- Want to skip db-sync entirely (Blockfrost fallback for `/history`,
  `/utxos` + `/tx` 503)? Leave both `CF_TUNNEL_DBSYNC_HOSTNAME` and
  `DBSYNC_URL` empty. Set `BLOCKFROST_PROJECT_ID_PREPROD`.

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
(empty strings); the real values are managed in DO. Two patterns
work:

### A. Manage in the DO dashboard (simplest, recommended)

1. `make do-deploy` once with the placeholder spec. The container
   may restart-loop until the tunnel envs are filled in — expected.
2. In the DO dashboard → your app → Settings → backend component →
   Environment Variables, edit each variable and paste the real
   value:
   - `CF_TUNNEL_OGMIOS_HOSTNAME`, `CF_TUNNEL_DBSYNC_HOSTNAME`
     (plaintext, e.g. `ogmios-preprod.yourdomain.com`)
   - `CF_TUNNEL_SERVICE_TOKEN_ID`, `CF_TUNNEL_SERVICE_TOKEN_SECRET`
     (SECRET — Client ID + Client Secret from CF Zero Trust)
   - `DBSYNC_URL` (SECRET — `postgres://user:pass@127.0.0.1:5432/cexplorer`)
   - `BLOCKFROST_PROJECT_ID_PREPROD` (SECRET — optional fallback)
3. DO triggers a redeploy; the cloudflared sidecar comes up,
   indexer connects, `/health` flips to 200.

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
- All `scope: BUILD_TIME` UI envs _except_ tokens — but remember
  build-time UI envs end up in the bundle anyway (see "UI build-time
  secrets" below), so a free-tier Blockfrost project ID is fine
  there even though it's marked SECRET.

### What must never be committed

- Demeter / DRI URLs that include a token query param.
- Postgres connection strings with passwords.
- Any paid-tier Blockfrost project ID.

## Environment variable matrix

### Backend (runtime — read by `backend/src/config.ts` + `backend/entrypoint.sh`)

| Var                              | Required                        | Type       | Default                                   | Notes                                                                                   |
| -------------------------------- | ------------------------------- | ---------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `NETWORK`                        | yes                             | plaintext  | `preprod`                                 | Must match the `NETWORK` build-arg used to bake `addresses.json`.                       |
| `PORT`                           | yes                             | plaintext  | `3001`                                    | Fastify listens here. DO health-checks the same port.                                   |
| `HOST`                           | no                              | plaintext  | `0.0.0.0`                                 | Container-friendly default; do not set `127.0.0.1`.                                     |
| `OGMIOS_URL`                     | yes                             | plaintext  | `ws://127.0.0.1:1337`                     | Loopback when the CF Tunnel sidecar runs; otherwise a directly-reachable URL.           |
| `DBSYNC_URL`                     | no                              | **secret** | –                                         | `postgres://user:pass@127.0.0.1:5432/cexplorer` (CF Tunnel) or any direct postgres URL. |
| `BLOCKFROST_PROJECT_ID_PREPROD`  | no                              | **secret** | –                                         | History fallback when db-sync is down. Suffix matches the network.                      |
| `BLOCKFROST_BASE_URL`            | no                              | plaintext  | per-network public Blockfrost             | Override only if you proxy.                                                             |
| `ADDRESSES_PATH`                 | no                              | plaintext  | `/srv/lovejoin/addresses.json`            | Matches the `COPY` in `backend/Dockerfile`.                                             |
| `CORS_ORIGINS`                   | yes                             | plaintext  | –                                         | Comma-separated allowlist; `${APP_URL}` works on DO. `*` allows all.                    |
| `RATE_LIMIT_PER_MIN`             | no                              | plaintext  | `600`                                     | Per-IP rate limit on every Fastify route.                                               |
| `BOOTSTRAP_START_SLOT`           | no                              | plaintext  | `addresses.bootstrapStartPoint.slot`      | Override the chainsync intersection.                                                    |
| `BOOTSTRAP_START_BLOCKHASH`      | no                              | plaintext  | `addresses.bootstrapStartPoint.blockHash` | Required iff `BOOTSTRAP_START_SLOT` is set.                                             |
| `INDEXER_COLD_START`             | no                              | plaintext  | `prime`                                   | `prime` = bulk-load from db-sync at startup; `replay` = legacy walk from bootstrap pt.  |
| `INDEXER_PRIME_TIMEOUT_MS`       | no                              | plaintext  | `60000`                                   | Per-query cap for the cold-start prime. Higher than the public-API 10s cap by design.   |
| `CF_TUNNEL_OGMIOS_HOSTNAME`      | no                              | plaintext  | –                                         | If set, entrypoint runs `cloudflared access tcp` for it on 127.0.0.1:1337.              |
| `CF_TUNNEL_DBSYNC_HOSTNAME`      | no                              | plaintext  | –                                         | Same, on 127.0.0.1:5432.                                                                |
| `CF_TUNNEL_SERVICE_TOKEN_ID`     | iff a CF tunnel hostname is set | **secret** | –                                         | CF Access service-token Client ID.                                                      |
| `CF_TUNNEL_SERVICE_TOKEN_SECRET` | iff a CF tunnel hostname is set | **secret** | –                                         | CF Access service-token Client Secret.                                                  |

### UI (build-time — read by Vite from the workspace `.env`)

> **Build-time = baked into the static bundle.** Each environment
> (preprod vs mainnet) needs its **own image build** with its own
> `VITE_*` values. There is no runtime way to swap them — the values
> become string literals in `dist/assets/*.js`.

| Var                          | Required | Type           | Default                 | Notes                                                                                            |
| ---------------------------- | -------- | -------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `VITE_NETWORK`               | yes      | plaintext      | `preprod`               | Drives the SDK's per-network code paths.                                                         |
| `VITE_BACKEND_URL`           | yes      | plaintext      | `http://localhost:3001` | Full URL incl. scheme. On DO use `${APP_URL}/api` so the same hostname serves both UI + backend. |
| `VITE_BLOCKFROST_PROJECT_ID` | no       | **secret-ish** | –                       | Optional client-side Blockfrost fallback. See "UI build-time secrets".                           |
| `VITE_COLLATERAL_ENDPOINT`   | no       | plaintext      | SDK per-network default | Override only when proxying or testing locally.                                                  |

#### UI build-time secrets

Anything passed as `VITE_*` ends up in the JavaScript bundle that ships
to every browser — _that includes secrets you mark as `type: SECRET`
in the App spec_. The `SECRET` flag only masks the value in the DO
spec audit log + dashboard; the resulting bundle is still
human-readable. Implications:

- **Never put a write-scoped or paid-tier API key in `VITE_*`.** A
  free-tier Blockfrost project ID is the right shape — readers can
  scrape it from the bundle either way.
- The collateral provider endpoint is non-sensitive (it's a public
  HTTPS host); leaving it as plaintext is fine.
- The backend's `OGMIOS_URL` and `DBSYNC_URL` _are_ secrets and live
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
- A staging environment — Preprod _is_ staging until mainnet is live
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
