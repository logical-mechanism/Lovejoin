#!/usr/bin/env bash
# 01a-publish-mix-box.sh — publish mix_box as a CIP-33 reference script.
#
# Mirrors the canonical pattern from logical-mechanism's deployments: source
# .env, query protocol params, gather wallet UTxOs (excluding SEED +
# COLLATERAL), build/sign/submit a single tx with `cardano-cli transaction
# build`. Wait for confirmation (./balance.sh) before running 01b.

set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/_publish_lib.sh"
require_ready_addresses "01a-publish-mix-box"
publish_ref_script "01a-publish-mix-box" "mix_box.plutus" "mix_box"
