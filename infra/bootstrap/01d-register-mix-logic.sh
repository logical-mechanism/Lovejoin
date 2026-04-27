#!/usr/bin/env bash
# 01d-register-mix-logic.sh — register the mix_logic stake credential.
#
# Mirrors the logical-mechanism cert-registration pattern:
#   * Spend wallet UTxOs (everything except SEED + COLLATERAL).
#   * --tx-in-collateral $COLLATERAL.
#   * --certificate-tx-in-reference  derived offline from the signed
#     01b-publish-mix-logic.tx file (so it works even if the publish tx
#     hasn't yet been queryable as a reference input through the node's
#     UTxO query — `transaction build`'s ref-input lookup is more forgiving
#     than `--tx-in`).
#   * --certificate-plutus-script-v3 + --certificate-reference-tx-in-redeemer-file.
#
# Run only after 01b has confirmed (./balance.sh — its mix_logic ref UTxO
# must be queryable on chain for the cert tx's build to succeed).

set -euo pipefail

__BOOTSTRAP_DIR="$(cd "$(dirname "$0")" && pwd)"
__ENV_FILE="$__BOOTSTRAP_DIR/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"

WALLETS_DIR="$__BOOTSTRAP_DIR/wallets"
: "${BOOTSTRAP_ADDR:=$([[ -f "$WALLETS_DIR/payment.$NETWORK.addr" ]] && cat "$WALLETS_DIR/payment.$NETWORK.addr" || echo '')}"
: "${PAYMENT_SKEY:=$WALLETS_DIR/payment.skey}"

COLLATERAL="${COLLATERAL:?COLLATERAL required (run ./balance.sh for the export lines)}"

REPO_ROOT="$(cd "$__BOOTSTRAP_DIR/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
TMP_DIR="$ARTIFACTS_DIR/tmp"
mkdir -p "$TMP_DIR"

# Pre-flight: 01b's signed file must exist (we derive the mix_logic ref
# UTxO id from it, exactly like the groth example).
PUBLISH_MIX_LOGIC_TX="$ARTIFACTS_DIR/01b-publish-mix-logic.tx"
if [[ ! -f "$PUBLISH_MIX_LOGIC_TX" ]]; then
  echo "01d-register-mix-logic: $PUBLISH_MIX_LOGIC_TX not found — run 01b first" >&2
  exit 1
fi

MIX_LOGIC_TXID=$(cardano-cli conway transaction txid \
  --tx-file "$PUBLISH_MIX_LOGIC_TX" | grep -oE '[a-f0-9]{64}' | head -n1)
MIX_LOGIC_REF_UTXO="${MIX_LOGIC_TXID}#0"

# Protocol params — needed for the build's fee + cost-model lookup.
cardano-cli conway query protocol-parameters \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$TMP_DIR/protocol.json"

# Wallet UTxOs (everything except SEED + COLLATERAL goes into --tx-in).
cardano-cli conway query utxo \
  --testnet-magic "$TESTNET_MAGIC" \
  --address "$BOOTSTRAP_ADDR" \
  --out-file "$TMP_DIR/wallet.utxo.json"

TX_IN_ARGS=$(jq -r \
  --arg seed "${SEED:-}" \
  --arg collat "$COLLATERAL" '
  to_entries
  | map(.key | select(. != $seed and . != $collat))
  | map("--tx-in " + .)
  | join(" ")
' "$TMP_DIR/wallet.utxo.json")

if [[ -z "$TX_IN_ARGS" ]]; then
  echo "01d-register-mix-logic: no spendable wallet UTxOs (after excluding SEED + COLLATERAL)" >&2
  exit 1
fi

# Stake-cred registration cert + the empty redeemer mix_logic.publish ignores.
KEY_DEPOSIT=$(jq -r '.stakeAddressDeposit' "$TMP_DIR/protocol.json")
STAKE_REG_CERT="$ARTIFACTS_DIR/mix_logic-stake-registration.cert"
cardano-cli conway stake-address registration-certificate \
  --stake-script-file "$ARTIFACTS_DIR/mix_logic.plutus" \
  --key-reg-deposit-amt "$KEY_DEPOSIT" \
  --out-file "$STAKE_REG_CERT"

EMPTY_REDEEMER="$ARTIFACTS_DIR/empty-redeemer.json"
echo '{"constructor":0,"fields":[]}' > "$EMPTY_REDEEMER"

TX_RAW="$ARTIFACTS_DIR/01d-register-mix-logic.txraw"

# shellcheck disable=SC2086
cardano-cli conway transaction build \
  --testnet-magic "$TESTNET_MAGIC" \
  $TX_IN_ARGS \
  --tx-in-collateral "$COLLATERAL" \
  --certificate-file "$STAKE_REG_CERT" \
  --certificate-tx-in-reference "$MIX_LOGIC_REF_UTXO" \
  --certificate-plutus-script-v3 \
  --certificate-reference-tx-in-redeemer-file "$EMPTY_REDEEMER" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$ARTIFACTS_DIR/01d-register-mix-logic.tx"

cardano-cli conway transaction submit \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-file "$ARTIFACTS_DIR/01d-register-mix-logic.tx"

TX_ID=$(cardano-cli conway transaction txid \
  --tx-file "$ARTIFACTS_DIR/01d-register-mix-logic.tx" \
  | grep -oE '[a-f0-9]{64}' | head -n1)
echo "01d-register-mix-logic: submitted txid $TX_ID"
echo "01d-register-mix-logic: mix_logic stake credential registered. Withdraw-zero spends are now valid."
