# shellcheck shell=bash
# infra/bootstrap/_lib/network.sh — sourced by every bootstrap script after `.env`.
#
# Validates $NETWORK and derives a CARDANO_CLI_NETWORK_FLAGS array so each
# script can pass the same flag(s) to cardano-cli regardless of network. This
# centralizes the magic-number table (preprod=1, preview=2, --mainnet) so
# adding mainnet support to the ceremony is a one-variable flip in `.env`,
# not a hand-edit of every script.
#
# Inputs (env, set by .env or the caller):
#
#   NETWORK                   — preprod | preview | mainnet | test
#                                (default: preprod)
#
#   TESTNET_MAGIC             — required only when NETWORK=test. Ignored
#                                otherwise; preprod / preview / mainnet use
#                                their canonical flags hard-coded below.
#
#   LOVEJOIN_MAINNET_CONFIRM  — must equal "yes" before any mainnet op will
#                                run. Tripwire so an accidental NETWORK=mainnet
#                                does not burn a real seed UTxO.
#
# Exports:
#
#   NETWORK                       — normalized + validated
#   CARDANO_CLI_NETWORK_FLAGS     — bash array; expand with
#                                    "${CARDANO_CLI_NETWORK_FLAGS[@]}".
#                                    Examples: (--testnet-magic 1) for preprod,
#                                    (--mainnet) for mainnet.
#
# Idempotent: re-sourcing is a no-op (guarded by LOVEJOIN_BOOTSTRAP_NETWORK_LIB).

if [[ "${LOVEJOIN_BOOTSTRAP_NETWORK_LIB:-}" == "loaded" ]]; then
  return 0
fi

# Identify the calling script for clearer error prefixes. BASH_SOURCE[1] is
# the script that sourced us; falling back to BASH_SOURCE[0] keeps the error
# usable if someone source's the lib directly for debugging.
__network_caller="$(basename "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")"

NETWORK="${NETWORK:-preprod}"

case "$NETWORK" in
  preprod)
    CARDANO_CLI_NETWORK_FLAGS=(--testnet-magic 1)
    ;;
  preview)
    CARDANO_CLI_NETWORK_FLAGS=(--testnet-magic 2)
    ;;
  mainnet)
    if [[ "${LOVEJOIN_MAINNET_CONFIRM:-}" != "yes" ]]; then
      echo "$__network_caller: NETWORK=mainnet refused — set LOVEJOIN_MAINNET_CONFIRM=yes to proceed." >&2
      echo "  Mainnet bootstrap is one-shot per network and burns the seed UTxO." >&2
      echo "  This guard is here so an accidental NETWORK=mainnet (typo, stale shell, copy-pasted command) does not burn a real seed." >&2
      exit 1
    fi
    CARDANO_CLI_NETWORK_FLAGS=(--mainnet)
    ;;
  test)
    if [[ -z "${TESTNET_MAGIC:-}" ]]; then
      echo "$__network_caller: NETWORK=test requires TESTNET_MAGIC to be set." >&2
      echo "  test mode is for private testnets; preprod/preview have canonical magics built in." >&2
      exit 1
    fi
    CARDANO_CLI_NETWORK_FLAGS=(--testnet-magic "$TESTNET_MAGIC")
    ;;
  *)
    echo "$__network_caller: unsupported NETWORK=$NETWORK (expected: preprod | preview | mainnet | test)." >&2
    exit 1
    ;;
esac

unset __network_caller

export NETWORK
LOVEJOIN_BOOTSTRAP_NETWORK_LIB=loaded
