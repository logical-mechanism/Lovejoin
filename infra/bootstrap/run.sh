#!/usr/bin/env bash
# run.sh — single-command bootstrap orchestrator.
#
# Runs the whole bootstrap end-to-end with confirmation waits between stages:
#
#     init-wallet   (lazy: only if the wallet doesn't exist yet)
#     balance       (sanity check — fail fast if wallet has no UTxOs)
#     prep-utxos    (split faucet drop into the 4 shapes the stages need)
#     wait
#     00-build-reference.sh     (offline)
#     01-publish-and-register.sh (chain of 4 txs)
#     wait
#     02-mint-and-lock.sh       (IRREVERSIBLE)
#     wait
#     03-fund-fee-contract.sh
#     wait
#
# Each "wait" polls cardano-cli for the previous stage's last tx until it
# appears in the on-chain UTxO set. On Preprod the typical block window is
# ~20s, so confirmations land in 20-60s on happy path.
#
# Inputs (env):
#   NETWORK            — preprod | preview (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   CARDANO_NODE_SOCKET_PATH must point to a synced node.
#   BOOTSTRAP_ADDR     — wallet address (default: read from wallets/payment.<network>.addr).
#   PAYMENT_SKEY       — bootstrap signing key (default: wallets/payment.skey).
#   CONFIRMATION_TIMEOUT_S  — per-tx wait timeout (default 300; 5 min).
#
# Recovery: if any stage fails partway, the per-stage scripts can be run
# manually using the env vars printed by prep-utxos. addresses.json is the
# source of truth for what's already been done.

set -euo pipefail

__ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
CONFIRMATION_TIMEOUT_S="${CONFIRMATION_TIMEOUT_S:-300}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
WALLETS_DIR="$SCRIPT_DIR/wallets"

# Env defaults from wallets/.
: "${BOOTSTRAP_ADDR:=$([[ -f "$WALLETS_DIR/payment.$NETWORK.addr" ]] && cat "$WALLETS_DIR/payment.$NETWORK.addr" || echo '')}"
: "${PAYMENT_SKEY:=$WALLETS_DIR/payment.skey}"

if [[ -z "$BOOTSTRAP_ADDR" ]]; then
  echo "run: BOOTSTRAP_ADDR not set and wallets/payment.$NETWORK.addr doesn't exist." >&2
  echo "     Run ./infra/bootstrap/init-wallet.sh first, then re-run this script." >&2
  exit 1
fi
if [[ ! -f "$PAYMENT_SKEY" ]]; then
  echo "run: PAYMENT_SKEY not found at $PAYMENT_SKEY. Run ./infra/bootstrap/init-wallet.sh first." >&2
  exit 1
fi

export NETWORK TESTNET_MAGIC BOOTSTRAP_ADDR PAYMENT_SKEY

mkdir -p "$ARTIFACTS_DIR"

heading() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
log() { printf "    %s\n" "$*"; }

# Wait for a tx to appear on chain by polling its first output. Polling
# `cardano-cli query utxo --tx-in <ref>` is robust on both happy and rollback
# paths — once the UTxO is in the ledger, the query returns it.
wait_for_tx() {
  local txid="$1" label="$2"
  local elapsed=0
  log "waiting for $label ($txid)…"
  while [[ $elapsed -lt $CONFIRMATION_TIMEOUT_S ]]; do
    local out
    out=$(cardano-cli conway query utxo \
            --testnet-magic "$TESTNET_MAGIC" \
            --tx-in "${txid}#0" \
            --output-json 2>/dev/null || echo '{}')
    if [[ "$(echo "$out" | jq 'length')" -gt 0 ]]; then
      log "confirmed in ${elapsed}s"
      return 0
    fi
    sleep 10
    elapsed=$((elapsed + 10))
  done
  log "TIMEOUT after ${CONFIRMATION_TIMEOUT_S}s waiting for $label"
  return 1
}

# Convenience: txid from a signed tx file.
txid_of_file() {
  cardano-cli conway transaction txid --tx-file "$1"
}

# ---------------------------------------------------------------------------
# Pre-flight: balance check
# ---------------------------------------------------------------------------
heading "Pre-flight: wallet balance"
"$SCRIPT_DIR/balance.sh"

# ---------------------------------------------------------------------------
# Stage A: split UTxOs
# ---------------------------------------------------------------------------
heading "Splitting wallet UTxOs"
"$SCRIPT_DIR/prep-utxos.sh"

PREP_TX_FILE="$ARTIFACTS_DIR/prep-utxos.tx"
if [[ -f "$PREP_TX_FILE" ]]; then
  PREP_TXID=$(txid_of_file "$PREP_TX_FILE")
  wait_for_tx "$PREP_TXID" "prep-utxos"
else
  log "prep-utxos was a no-op (≥ 4 ada-only UTxOs already at the wallet)."
  log "Looking for the 4 specific UTxOs by size in the wallet snapshot…"
  # Reuse prep-utxos's snapshot if it exists; otherwise refresh.
  UTXO_JSON="$ARTIFACTS_DIR/prep-utxos.utxo.json"
  if [[ ! -f "$UTXO_JSON" ]]; then
    cardano-cli conway query utxo \
      --testnet-magic "$TESTNET_MAGIC" \
      --address "$BOOTSTRAP_ADDR" \
      --out-file "$UTXO_JSON"
  fi
  # Heuristic: pick the four ada-only UTxOs whose values match the prep-utxos
  # defaults. If prep-utxos sizes were customized, run it from a clean wallet.
  PREP_TXID=""  # not applicable; we'll use absolute refs
fi

# Read the four canonical refs from the same source prep-utxos used (so the
# output indices match its --tx-out order: 0,1,2,3 → A,B,C,D).
if [[ -n "${PREP_TXID:-}" ]]; then
  FUNDING_STAGE1="${PREP_TXID}#0"
  COLLATERAL="${PREP_TXID}#1"
  SEED="${PREP_TXID}#2"
  FUNDING_STAGE3="${PREP_TXID}#3"
else
  log "Manual mode: pre-existing UTxOs detected. Set the four env vars and re-run, or"
  log "wipe the wallet's ada-only UTxOs and let prep-utxos do the split."
  exit 1
fi

log "FUNDING_STAGE1 = $FUNDING_STAGE1"
log "COLLATERAL     = $COLLATERAL"
log "SEED           = $SEED"
log "FUNDING_STAGE3 = $FUNDING_STAGE3"

# ---------------------------------------------------------------------------
# Stage 0: offline build
# ---------------------------------------------------------------------------
heading "Stage 0: build reference (offline)"
"$REPO_ROOT/contracts/build.sh" "config/network.$NETWORK.json"
SEED_UTXO="$SEED" "$SCRIPT_DIR/00-build-reference.sh"

# ---------------------------------------------------------------------------
# Stage 1: publish + register chain
# ---------------------------------------------------------------------------
heading "Stage 1: publish reference scripts + register mix_logic stake credential"
FUNDING_UTXO="$FUNDING_STAGE1" COLLATERAL_UTXO="$COLLATERAL" \
  "$SCRIPT_DIR/01-publish-and-register.sh"
STAGE1_TX_FILE="$ARTIFACTS_DIR/01d-register-mix-logic.tx"
wait_for_tx "$(txid_of_file "$STAGE1_TX_FILE")" "stage 1 cert registration"

# ---------------------------------------------------------------------------
# Stage 2: irreversible mint + lock
# ---------------------------------------------------------------------------
heading "Stage 2: mint NFT + lock at reference_holder (IRREVERSIBLE)"
SEED_UTXO="$SEED" COLLATERAL_UTXO="$COLLATERAL" \
  "$SCRIPT_DIR/02-mint-and-lock.sh"
STAGE2_TX_FILE="$ARTIFACTS_DIR/02-mint-and-lock.tx"
wait_for_tx "$(txid_of_file "$STAGE2_TX_FILE")" "stage 2 mint+lock"

# ---------------------------------------------------------------------------
# Stage 3: fund 10 fee shards
# ---------------------------------------------------------------------------
heading "Stage 3: fund 10 fee shards"
FUNDING_UTXO="$FUNDING_STAGE3" \
  "$SCRIPT_DIR/03-fund-fee-contract.sh"
STAGE3_TX_FILE="$ARTIFACTS_DIR/03-fund-fee-contract.tx"
wait_for_tx "$(txid_of_file "$STAGE3_TX_FILE")" "stage 3 fund fee shards"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
heading "Bootstrap complete"
ADDR_FILE="$ARTIFACTS_DIR/addresses.json"
log "NFT policy:        $(jq -r '.referenceNftPolicy' "$ADDR_FILE")"
log "NFT asset name:    $(jq -r '.referenceNftAssetName' "$ADDR_FILE")"
log "reference UTxO:    $(jq -r '.referenceUtxoRef' "$ADDR_FILE")"
log "mix_logic hash:    $(jq -r '.mixLogicScriptHash' "$ADDR_FILE")"
log "mix_box hash:      $(jq -r '.mixBoxScriptHash' "$ADDR_FILE")"
log "fee_contract hash: $(jq -r '.feeScriptHash' "$ADDR_FILE")"
log "fee shards:        $(jq '.feeShardUtxos | length' "$ADDR_FILE") UTxOs"
log ""
log "Commit the address book:"
log "  git add artifacts/$NETWORK/addresses.json"
log "  git commit -m \"bootstrap($NETWORK): mint NFT $(jq -r '.referenceNftPolicy' $ADDR_FILE)\""
