# Lovejoin top-level Makefile.
# See docs/spec/12-build-guide.md for the per-milestone build order.

PNPM ?= pnpm
AIKEN ?= aiken
# Network whose artifacts we emit by default. Override with
#   make contracts NETWORK_CONFIG=config/network.preview.json
NETWORK_CONFIG ?= config/network.preprod.json

.PHONY: help install build test contracts ui-dev backend-dev clean

help:
	@echo "Lovejoin — top-level targets"
	@echo "  make install        # pnpm install (workspace deps)"
	@echo "  make build          # builds contracts + offchain + backend + ui"
	@echo "  make test           # runs all package tests + aiken check"
	@echo "  make contracts      # aiken build + emits artifacts/<network>/{blueprint.json, *.plutus, addresses.json}"
	@echo "                      # default network from \$$NETWORK_CONFIG = $(NETWORK_CONFIG)"
	@echo "  make ui-dev         # starts the vite dev server"
	@echo "  make backend-dev    # starts the backend against Preprod"
	@echo "  make clean          # removes build artifacts"

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

ui-dev:
	$(PNPM) --filter @lovejoin/ui run dev

backend-dev:
	$(PNPM) --filter @lovejoin/backend run dev

clean:
	rm -rf offchain/dist backend/dist ui/dist contracts/build crypto/ref/target
