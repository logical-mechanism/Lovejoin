#!/bin/sh
# Lovejoin backend container entrypoint.
#
# Conditionally launches one or two `cloudflared access tcp` sidecars
# (Ogmios + db-sync) before exec'ing the Node API server. Both sidecars
# are gated on the corresponding CF_TUNNEL_*_HOSTNAME env var: unset =
# skip, the operator is using a directly-reachable URL.
#
# When a sidecar is enabled, point the matching backend env at the
# loopback listener cloudflared opens:
#   OGMIOS_URL=ws://127.0.0.1:1337
#   DBSYNC_URL=postgres://USER:PASS@127.0.0.1:5432/DBNAME
#
# Cloudflare Access service-token auth is mandatory when the home-side
# Access application enforces a policy (it should). The `cloudflared
# access` *client* — which is what we run here, distinct from the
# `cloudflared tunnel` daemon on the home server — reads
# CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET from the env. (The
# TUNNEL_SERVICE_TOKEN_* env vars used by the tunnel daemon are a
# different auth context entirely; mixing them up gives a "websocket:
# bad handshake" against CF's edge.)
#
# See docs/deploy.md §"Connecting App Platform to home-hosted infrastructure".

set -eu

OGMIOS_LOCAL_PORT=1337
DBSYNC_LOCAL_PORT=5432

# Translate operator-friendly env names into the ones cloudflared's
# access client expects. Only export when both are set so a bare
# `cloudflared access` without auth fails fast on a misconfig instead
# of hitting CF Access without credentials and 403'ing in a confusing
# way.
if [ -n "${CF_TUNNEL_SERVICE_TOKEN_ID:-}" ] && [ -n "${CF_TUNNEL_SERVICE_TOKEN_SECRET:-}" ]; then
    export CF_ACCESS_CLIENT_ID="$CF_TUNNEL_SERVICE_TOKEN_ID"
    export CF_ACCESS_CLIENT_SECRET="$CF_TUNNEL_SERVICE_TOKEN_SECRET"
fi

start_cf_tcp() {
    name="$1"
    hostname="$2"
    local_port="$3"

    echo "entrypoint: starting cloudflared access tcp for $name (-> $hostname:$local_port)" >&2
    cloudflared access tcp \
        --hostname "$hostname" \
        --url "127.0.0.1:$local_port" &

    # Wait up to 30s for the local listener to come up. cloudflared's
    # access tcp opens the listen socket synchronously after the
    # Access auth handshake, so an unreachable listener after this
    # window almost always means the service token is wrong or the
    # CF Access application doesn't exist for this hostname.
    i=0
    while [ "$i" -lt 30 ]; do
        if nc -z 127.0.0.1 "$local_port" 2>/dev/null; then
            echo "entrypoint: cloudflared listener for $name ready on 127.0.0.1:$local_port" >&2
            return 0
        fi
        i=$((i + 1))
        sleep 1
    done

    echo "entrypoint: cloudflared listener for $name ($hostname) not ready after 30s — check CF Access policy + service token" >&2
    exit 1
}

if [ -n "${CF_TUNNEL_OGMIOS_HOSTNAME:-}" ]; then
    start_cf_tcp "ogmios" "$CF_TUNNEL_OGMIOS_HOSTNAME" "$OGMIOS_LOCAL_PORT"
fi

if [ -n "${CF_TUNNEL_DBSYNC_HOSTNAME:-}" ]; then
    start_cf_tcp "dbsync" "$CF_TUNNEL_DBSYNC_HOSTNAME" "$DBSYNC_LOCAL_PORT"
fi

# `exec` replaces the shell so node becomes the foreground process;
# tini (PID 1) then sees node's exit code and forwards SIGTERM to the
# whole process group on shutdown — cloudflared dies with it.
exec node dist/index.js
