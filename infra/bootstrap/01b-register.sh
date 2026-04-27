#!/usr/bin/env bash
# 01b-register.sh — register the mix_logic stake credential.
#
# Pays the protocol's stake-key deposit to register the script credential and
# fires `mix_logic.publish` with `RegisterCredential`. After this confirms,
# zero-withdraw spends of mix_logic become valid (Mix and Owner txs use the
# stake credential as their carrier).
#
# Why this is split from 01a-publish.sh: by the time we reach the cert tx,
# 01a's three publishes have confirmed and cardano-cli's `transaction build`
# can resolve their UTxOs. So we use `build` here (auto fee + change) instead
# of `build-raw` (manual). Run AFTER 01a-publish.sh confirms.
#
# Inputs (env, typically via .env + prep-utxos exports):
#   NETWORK            — preprod | preview (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   CARDANO_NODE_SOCKET_PATH must point to a synced node.
#   BOOTSTRAP_ADDR     — wallet address (auto-defaulted from wallets/).
#   PAYMENT_SKEY       — bootstrap signing key (auto-defaulted).
#   COLLATERAL         — ada-only UTxO for tx Plutus exec. Preserved on
#                        script success.
#   STAGE1_CHANGE      — funding UTxO. Defaults to addresses.json's
#                        stage1ChangeUtxo (left there by 01a-publish.sh).
#
# Reads:
#   artifacts/<network>/addresses.json
#     .referenceScriptUtxos.mix_logic   (cert ref-script UTxO)
#     .stage1ChangeUtxo                 (funding default)
#   artifacts/<network>/mix_logic.plutus  (cert script-file source)
#
# Writes:
#   artifacts/<network>/01b-register.tx
#   artifacts/<network>/addresses.json    (.mixLogicRegisterTx populated)

set -euo pipefail

__BOOTSTRAP_DIR="$(cd "$(dirname "$0")" && pwd)"
__ENV_FILE="$__BOOTSTRAP_DIR/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
WALLETS_DIR="$__BOOTSTRAP_DIR/wallets"
: "${BOOTSTRAP_ADDR:=$([[ -f "$WALLETS_DIR/payment.$NETWORK.addr" ]] && cat "$WALLETS_DIR/payment.$NETWORK.addr" || echo '')}"
: "${PAYMENT_SKEY:=$WALLETS_DIR/payment.skey}"

COLLATERAL="${COLLATERAL:?COLLATERAL required (run ./balance.sh)}"

REPO_ROOT="$(cd "$__BOOTSTRAP_DIR/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
TMP_DIR="$ARTIFACTS_DIR/tmp"
mkdir -p "$TMP_DIR"

ADDRESSES="$ARTIFACTS_DIR/addresses.json"

MIX_LOGIC_REF=$(jq -r '.referenceScriptUtxos.mix_logic // empty' "$ADDRESSES")
if [[ -z "$MIX_LOGIC_REF" ]]; then
  echo "01b-register: addresses.json missing referenceScriptUtxos.mix_logic — run 01a-publish.sh first" >&2
  exit 1
fi

STAGE1_CHANGE="${STAGE1_CHANGE:-$(jq -r '.stage1ChangeUtxo // empty' "$ADDRESSES")}"
if [[ -z "$STAGE1_CHANGE" ]]; then
  echo "01b-register: STAGE1_CHANGE not set and addresses.json has no stage1ChangeUtxo — run 01a-publish.sh first or set STAGE1_CHANGE" >&2
  exit 1
fi

if [[ "$STAGE1_CHANGE" == "$COLLATERAL" ]]; then
  echo "01b-register: STAGE1_CHANGE and COLLATERAL must differ (ledger forbids overlap)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Protocol params (for the stake-deposit amount + transaction build).
# ---------------------------------------------------------------------------
cardano-cli conway query protocol-parameters \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$TMP_DIR/protocol.json"

KEY_DEPOSIT=$(jq -r '.stakeAddressDeposit' "$TMP_DIR/protocol.json")

# ---------------------------------------------------------------------------
# Stake registration certificate for the mix_logic script credential. The
# Plutus credential's `publish` handler validates that the cert is a
# RegisterCredential — see contracts/validators/mix_logic.ak.
# ---------------------------------------------------------------------------
STAKE_REG_CERT="$ARTIFACTS_DIR/mix_logic-stake-registration.cert"
cardano-cli conway stake-address registration-certificate \
  --stake-script-file "$ARTIFACTS_DIR/mix_logic.plutus" \
  --key-reg-deposit-amt "$KEY_DEPOSIT" \
  --out-file "$STAKE_REG_CERT"

EMPTY_REDEEMER="$ARTIFACTS_DIR/empty-redeemer.json"
echo '{"constructor":0,"fields":[]}' > "$EMPTY_REDEEMER"

# ---------------------------------------------------------------------------
# Build, sign, submit. `transaction build` queries on-chain UTxOs to compute
# fee + Plutus exec budget + change automatically.
# ---------------------------------------------------------------------------
TX_RAW="$ARTIFACTS_DIR/01b-register.txraw"

cardano-cli conway transaction build \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-in "$STAGE1_CHANGE" \
  --tx-in-collateral "$COLLATERAL" \
  --certificate-file "$STAKE_REG_CERT" \
  --certificate-tx-in-reference "$MIX_LOGIC_REF" \
  --certificate-plutus-script-v3 \
  --certificate-reference-tx-in-redeemer-file "$EMPTY_REDEEMER" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$ARTIFACTS_DIR/01b-register.tx"

cardano-cli conway transaction submit \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-file "$ARTIFACTS_DIR/01b-register.tx"

TX_ID=$(cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/01b-register.tx" \
        | grep -oE '[a-f0-9]{64}' | head -n1)

TMP=$(mktemp)
jq --arg tx "$TX_ID" '.mixLogicRegisterTx = $tx' "$ADDRESSES" > "$TMP"
mv "$TMP" "$ADDRESSES"

echo
echo "01b-register: submitted txid $TX_ID"
echo "Wait for confirmation, then run 02-mint-and-lock.sh."
