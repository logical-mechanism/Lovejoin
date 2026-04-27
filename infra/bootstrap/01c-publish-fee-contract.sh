#!/usr/bin/env bash
# 01c-publish-fee-contract.sh — publish fee_contract as a CIP-33 reference script.

set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/_publish_lib.sh"
require_ready_addresses "01c-publish-fee-contract"
publish_ref_script "01c-publish-fee-contract" "fee_contract.plutus" "fee_contract"
