#!/usr/bin/env bash
# 01-publish-and-register.sh — chained-tx infrastructure stage.
#
# Submits FOUR txs in a recursive chain (each spends the previous tx's change
# output as its funding input):
#
#   Tx 1: publish mix_box      ref script
#   Tx 2: publish mix_logic    ref script (the cert in tx 4 references this)
#   Tx 3: publish fee_contract ref script
#   Tx 4: register the mix_logic stake credential. Attaches mix_logic via
#         --certificate-tx-in-reference against tx 2's output, with redeemer
#         supplied via --certificate-reference-tx-in-redeemer-file.
#
# Single-script-per-tx by design: keeps each tx well under the 16 KiB max-tx-size
# limit (validators today are ~5 KiB total but headroom matters as they grow),
# and isolates failures (a publish that fails costs only its own funding + fee).
#
# The operator supplies ONE funding UTxO and ONE collateral UTxO. The script
# computes each subsequent funding UTxO offline by running
# `transaction txid` on the signed-but-unsubmitted tx files, then chains them.
# Submission is sequential — cardano-cli's `transaction build` resolves the
# next input against the local node's mempool + UTxO set, so the 2nd-4th
# builds need the 1st-3rd submissions already in flight.
#
# Inputs (env):
#   NETWORK            — "preprod" | "test" (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   CARDANO_NODE_SOCKET_PATH must point to a synced node.
#   BOOTSTRAP_ADDR     — wallet address; receives the 3 ref-script UTxOs +
#                        change. Also the cert-deposit refund-target if you
#                        ever (don't) deregister.
#   FUNDING_UTXO       — UTxO at BOOTSTRAP_ADDR funding the chain. Needs ≈ 80
#                        ADA on Preprod (3 ref outputs at ~25 ADA each + cert
#                        deposit ~2 ADA + 4 tx fees + comfortable change).
#   COLLATERAL_UTXO    — separate ada-only UTxO ≥ 5 ADA. Held in reserve in
#                        case mix_logic.publish (tx 4) fails. The publish
#                        handler is trivially True for RegisterCredential, so
#                        the collateral is never seized in practice.
#   PAYMENT_SKEY       — bootstrap wallet signing key.
#   REF_PUBLISH_LOVELACE  — lovelace per ref-script output (default 25_000_000).
#
# Writes: artifacts/<network>/addresses.json (referenceScriptUtxos populated).

set -euo pipefail

__ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
BOOTSTRAP_ADDR="${BOOTSTRAP_ADDR:?}"
FUNDING_UTXO="${FUNDING_UTXO:?}"
COLLATERAL_UTXO="${COLLATERAL_UTXO:?}"
PAYMENT_SKEY="${PAYMENT_SKEY:?}"
REF_PUBLISH_LOVELACE="${REF_PUBLISH_LOVELACE:-25000000}"

if [[ "$FUNDING_UTXO" == "$COLLATERAL_UTXO" ]]; then
  echo "01-publish-and-register: FUNDING_UTXO and COLLATERAL_UTXO must differ" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

if [[ "$(jq -r '.mixLogicScriptHash // empty' "$ARTIFACTS_DIR/addresses.json")" == "" ]]; then
  echo "01-publish-and-register: addresses.json is missing mixLogicScriptHash — run 00-build-reference.sh first" >&2
  exit 1
fi

# Empty redeemer (mix_logic.publish ignores its redeemer; one_shot_mint does too).
EMPTY_REDEEMER="$ARTIFACTS_DIR/empty-redeemer.json"
echo '{"constructor":0,"fields":[]}' > "$EMPTY_REDEEMER"

# Helper: build + sign one publish tx. Returns nothing; outputs go to stage files.
# Args: $1 stage tag (used as the file-name prefix)
#       $2 script basename to attach as reference script
#       $3 funding UTxO ref ("<txid>#<idx>")
publish_step() {
  local stage="$1" script="$2" funding="$3"
  local raw="$ARTIFACTS_DIR/$stage.txraw"
  cardano-cli conway transaction build \
    --testnet-magic "$TESTNET_MAGIC" \
    --tx-in "$funding" \
    --tx-out "$BOOTSTRAP_ADDR + $REF_PUBLISH_LOVELACE lovelace" \
    --tx-out-reference-script-file "$ARTIFACTS_DIR/$script" \
    --change-address "$BOOTSTRAP_ADDR" \
    --out-file "$raw"
  cardano-cli conway transaction sign \
    --tx-body-file "$raw" \
    --signing-key-file "$PAYMENT_SKEY" \
    --testnet-magic "$TESTNET_MAGIC" \
    --out-file "$ARTIFACTS_DIR/$stage.tx"
}

# txid of a signed tx file (offline; doesn't need the node). Newer cardano-cli
# returns JSON ({"txhash": "..."}); older returns plain hex. The txid is always
# a 64-char lowercase hex string, so grep gets it from either form.
txid_of() {
  cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/$1.tx" \
    | grep -oE '[a-f0-9]{64}' | head -n1
}

submit() {
  cardano-cli conway transaction submit \
    --testnet-magic "$TESTNET_MAGIC" \
    --tx-file "$ARTIFACTS_DIR/$1.tx"
}

# ---------------------------------------------------------------------------
# Tx 1: publish mix_box. Funds from FUNDING_UTXO. Output 0 = ref script;
# output 1 = change (becomes tx 2's funding).
# ---------------------------------------------------------------------------
echo "01a/4 — publishing mix_box ref script"
publish_step "01a-publish-mix-box" "mix_box.plutus" "$FUNDING_UTXO"
TX1=$(txid_of "01a-publish-mix-box")
submit "01a-publish-mix-box"
echo "  mix_box ref UTxO:      ${TX1}#0"

# ---------------------------------------------------------------------------
# Tx 2: publish mix_logic. Funds from tx 1's change output (#1).
# ---------------------------------------------------------------------------
echo "01b/4 — publishing mix_logic ref script"
publish_step "01b-publish-mix-logic" "mix_logic.plutus" "${TX1}#1"
TX2=$(txid_of "01b-publish-mix-logic")
submit "01b-publish-mix-logic"
echo "  mix_logic ref UTxO:    ${TX2}#0"

# ---------------------------------------------------------------------------
# Tx 3: publish fee_contract. Funds from tx 2's change.
# ---------------------------------------------------------------------------
echo "01c/4 — publishing fee_contract ref script"
publish_step "01c-publish-fee-contract" "fee_contract.plutus" "${TX2}#1"
TX3=$(txid_of "01c-publish-fee-contract")
submit "01c-publish-fee-contract"
echo "  fee_contract ref UTxO: ${TX3}#0"

# ---------------------------------------------------------------------------
# Tx 4: register the mix_logic stake credential. The script that authorizes
# the cert is referenced from tx 2's output via --certificate-tx-in-reference.
# Funding comes from tx 3's change; collateral is separate (ledger forbids
# overlap with the spending input).
# ---------------------------------------------------------------------------
echo "01d/4 — registering mix_logic stake credential"

STAKE_REG_CERT="$ARTIFACTS_DIR/mix_logic-stake-registration.cert"
KEY_DEPOSIT=$(cardano-cli conway query protocol-parameters --testnet-magic "$TESTNET_MAGIC" | jq -r '.stakeAddressDeposit')
cardano-cli conway stake-address registration-certificate \
  --stake-script-file "$ARTIFACTS_DIR/mix_logic.plutus" \
  --key-reg-deposit-amt "$KEY_DEPOSIT" \
  --out-file "$STAKE_REG_CERT"

TX4_RAW="$ARTIFACTS_DIR/01d-register-mix-logic.txraw"
cardano-cli conway transaction build \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-in "${TX3}#1" \
  --tx-in-collateral "$COLLATERAL_UTXO" \
  --certificate-file "$STAKE_REG_CERT" \
  --certificate-tx-in-reference "${TX2}#0" \
  --certificate-plutus-script-v3 \
  --certificate-reference-tx-in-redeemer-file "$EMPTY_REDEEMER" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX4_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX4_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$ARTIFACTS_DIR/01d-register-mix-logic.tx"

TX4=$(txid_of "01d-register-mix-logic")
submit "01d-register-mix-logic"
echo "  cert registration tx:  ${TX4}"

# ---------------------------------------------------------------------------
# Persist the ref-script UTxO refs into addresses.json.
# ---------------------------------------------------------------------------
TMP=$(mktemp)
jq --arg mb "${TX1}#0" --arg ml "${TX2}#0" --arg fc "${TX3}#0" '
  .referenceScriptUtxos = {
    mix_box: $mb,
    mix_logic: $ml,
    fee_contract: $fc
  }
' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

echo
echo "01-publish-and-register: chain submitted (4 txs). Wait for the last tx to"
echo "confirm before running 02-mint-and-lock.sh:"
echo "  cardano-cli conway query tx-status --testnet-magic $TESTNET_MAGIC --tx-hash $TX4"
