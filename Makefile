# Lovejoin top-level Makefile.
# See docs/spec/12-build-guide.md for the per-milestone build order.

PNPM ?= pnpm
AIKEN ?= aiken
NODE ?= node
# Network whose artifacts we emit by default. Override with
#   make contracts NETWORK_CONFIG=config/network.preview.json
NETWORK_CONFIG ?= config/network.preprod.json

# Where local secrets / runtime config live. `cp .env.example .env` and fill in.
# Node 22's --env-file-if-exists silently no-ops when the file is absent, so
# `make help` and `make build` still work without one.
ENV_FILE ?= .env
NODE_ENV_FLAG := --env-file-if-exists=$(ENV_FILE)

.PHONY: help install build test lint contracts ui-dev backend-dev clean \
        cli deposit withdraw integration-test sdk-test sdk-build

help:
	@echo "Lovejoin — top-level targets"
	@echo ""
	@echo "Build / test:"
	@echo "  make install            # pnpm install (workspace deps)"
	@echo "  make build              # builds contracts + offchain + backend + ui"
	@echo "  make test               # runs all package tests + aiken check"
	@echo "  make lint               # tsc --noEmit on TS workspaces + aiken fmt --check"
	@echo "  make sdk-build          # builds just the @lovejoin/sdk package"
	@echo "  make sdk-test           # runs just the SDK unit tests"
	@echo "  make contracts          # aiken build + emits artifacts/<network>/{blueprint.json, *.plutus, addresses.json}"
	@echo "                          # default network from \$$NETWORK_CONFIG = $(NETWORK_CONFIG)"
	@echo "  make clean              # removes build artifacts"
	@echo ""
	@echo "Dev servers:"
	@echo "  make ui-dev             # starts the vite dev server"
	@echo "  make backend-dev        # starts the backend against Preprod"
	@echo ""
	@echo "Lovejoin CLI / Preprod (loads $(ENV_FILE) automatically):"
	@echo "  make cli                # prints CLI help"
	@echo "  make deposit ROUNDS=30  # builds + submits a deposit tx"
	@echo "  make withdraw SECRET=... BOX_REF=... BOX_A=... BOX_B=... TO=..."
	@echo "  make integration-test   # runs the Preprod deposit-withdraw round-trip"

install:
	$(PNPM) install

# `contracts/build.sh` runs `aiken build` then writes per-validator artifacts
# under artifacts/<network>/. This is what 00-build-reference reads.
contracts:
	./contracts/build.sh $(NETWORK_CONFIG)

build: contracts
	$(PNPM) -r --filter ./offchain --filter ./backend --filter ./ui run build

test:
	cd contracts && $(AIKEN) check
	$(PNPM) -r --filter ./offchain --filter ./backend --filter ./ui run test

# Lint: type-check every TS workspace + check Aiken formatting. Each
# workspace's `lint` script is `tsc --noEmit` against its own tsconfig.
# `aiken fmt --check` is the format-only check (no test runs, no compile)
# so it stays cheap and catches whitespace / import-ordering drift.
# `aiken check` (typecheck + tests) lives under `make test`.
lint:
	cd contracts && $(AIKEN) fmt --check
	$(PNPM) -r --filter ./offchain --filter ./backend --filter ./ui run lint

sdk-build:
	$(PNPM) --filter @lovejoin/sdk build

sdk-test:
	$(PNPM) --filter @lovejoin/sdk test

ui-dev:
	$(PNPM) --filter @lovejoin/ui run dev

backend-dev:
	$(PNPM) --filter @lovejoin/backend run dev

clean:
	rm -rf offchain/dist backend/dist ui/dist contracts/build crypto/ref/target

# ---------------------------------------------------------------------------
# CLI / Preprod runners — all load .env via Node's --env-file-if-exists so
# secrets stay out of shell history. Set BLOCKFROST_PROJECT_ID_PREPROD,
# LOVEJOIN_PAYMENT_SKEY (or LOVEJOIN_MNEMONIC) in .env first.
# ---------------------------------------------------------------------------

# Build the SDK before running CLI targets so dist/cli/index.js exists.
cli: sdk-build
	$(NODE) $(NODE_ENV_FLAG) offchain/dist/cli/index.js help

ROUNDS ?= 30
deposit: sdk-build
	$(NODE) $(NODE_ENV_FLAG) offchain/dist/cli/index.js deposit --rounds $(ROUNDS)

withdraw: sdk-build
	@if [ -z "$(SECRET)" ] || [ -z "$(BOX_REF)" ] || [ -z "$(BOX_A)" ] || [ -z "$(BOX_B)" ] || [ -z "$(TO)" ]; then \
		echo "withdraw needs SECRET=, BOX_REF=, BOX_A=, BOX_B=, TO="; \
		exit 1; \
	fi
	$(NODE) $(NODE_ENV_FLAG) offchain/dist/cli/index.js withdraw \
		--secret $(SECRET) --box-ref $(BOX_REF) --box-a $(BOX_A) --box-b $(BOX_B) --to $(TO)

# Vitest doesn't surface --env-file directly, but it inherits process.env. We
# wrap the runner with `node --env-file-if-exists=.env -- pnpm` so the env is
# loaded before vitest spawns. (`node` won't exec `pnpm` directly, so we go
# through `pnpm` and let vitest pick up the populated env.)
integration-test: sdk-build
	@if [ -f $(ENV_FILE) ]; then \
		set -a; . ./$(ENV_FILE); set +a; \
		$(PNPM) --filter integration-tests test -- deposit-withdraw; \
	else \
		echo "WARN: $(ENV_FILE) not found — running test (will skip without env)"; \
		$(PNPM) --filter integration-tests test -- deposit-withdraw; \
	fi
