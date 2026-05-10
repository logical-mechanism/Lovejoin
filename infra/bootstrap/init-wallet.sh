#!/usr/bin/env bash
# init-wallet.sh — set up the bootstrap wallet (payment keypair + per-network
# address files). Idempotent: a re-run with an existing keypair / address
# leaves it untouched.
#
# A Cardano signing key carries no network identity — the same keypair works
# across networks; only the bech32 address encoding differs. So we generate
# ONE keypair and derive an address per network.
#
# Layout (everything under infra/bootstrap/wallets/, all gitignored):
#   payment.skey               # shared signing key (NEVER commit)
#   payment.vkey               # shared verification key
#   payment.preprod.addr       # bech32 address for preprod (testnet-magic 1)
#   payment.preview.addr       # bech32 address for preview (testnet-magic 2)
#   payment.mainnet.addr       # only if --include-mainnet is passed
#
# Usage:
#   ./init-wallet.sh                        # preprod + preview
#   ./init-wallet.sh --include-mainnet      # also generate mainnet address
#                                           # (the mainnet bootstrap itself
#                                           #  is gated by LOVEJOIN_MAINNET_CONFIRM
#                                           #  in _lib/network.sh; this just
#                                           #  produces the address file)
#
# After running, fund payment.preprod.addr from the Preprod faucet
# (https://docs.cardano.org/cardano-testnets/tools/faucet/).

set -euo pipefail

__ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

WALLETS_DIR="$(cd "$(dirname "$0")" && pwd)/wallets"
mkdir -p "$WALLETS_DIR"

SKEY="$WALLETS_DIR/payment.skey"
VKEY="$WALLETS_DIR/payment.vkey"

if [[ -f "$SKEY" && -f "$VKEY" ]]; then
  echo "init-wallet: keypair exists at $SKEY (skipping)"
elif [[ -f "$SKEY" || -f "$VKEY" ]]; then
  echo "init-wallet: half a keypair found ($SKEY / $VKEY). Refusing to overwrite — investigate first." >&2
  exit 1
else
  echo "init-wallet: generating keypair → $SKEY"
  cardano-cli conway address key-gen \
    --verification-key-file "$VKEY" \
    --signing-key-file "$SKEY"
  chmod 600 "$SKEY"
fi

# Build a per-network address. Skip if the file already exists.
gen_address() {
  local network="$1"
  shift
  local addr_file="$WALLETS_DIR/payment.$network.addr"
  if [[ -f "$addr_file" ]]; then
    echo "init-wallet: $network address exists at $addr_file (skipping)"
    return 0
  fi
  cardano-cli conway address build \
    --payment-verification-key-file "$VKEY" \
    "$@" \
    --out-file "$addr_file"
  echo "init-wallet: $network address → $(cat "$addr_file")"
}

gen_address preprod --testnet-magic 1
gen_address preview --testnet-magic 2

include_mainnet=0
for arg in "$@"; do
  case "$arg" in
    --include-mainnet) include_mainnet=1 ;;
  esac
done
if [[ "$include_mainnet" == "1" ]]; then
  gen_address mainnet --mainnet
fi

echo
echo "init-wallet: ready. Next:"
echo "  Fund the address for the network you're bootstrapping:"
echo "    cat $WALLETS_DIR/payment.preprod.addr"
echo "  Then export and run the bootstrap stages (see infra/bootstrap/README.md)."
