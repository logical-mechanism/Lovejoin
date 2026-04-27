#!/usr/bin/env bash
# 01b-publish-mix-logic.sh — publish mix_logic as a CIP-33 reference script.
# This output is what 01d's cert tx references via
# `--certificate-tx-in-reference`.

set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/_publish_lib.sh"
require_ready_addresses "01b-publish-mix-logic"
publish_ref_script "01b-publish-mix-logic" "mix_logic.plutus" "mix_logic"
