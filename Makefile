# Lovejoin top-level Makefile.
# See docs/spec/12-build-guide.md for the per-milestone build order.

PNPM ?= pnpm
AIKEN ?= aiken

.PHONY: help install build test contracts ui-dev backend-dev clean

help:
	@echo "Lovejoin — top-level targets"
	@echo "  make install        # pnpm install (workspace deps)"
	@echo "  make build          # builds contracts + offchain + backend + ui"
	@echo "  make test           # runs all package tests + aiken check"
	@echo "  make contracts      # rebuilds just the Aiken contracts"
	@echo "  make ui-dev         # starts the vite dev server"
	@echo "  make backend-dev    # starts the backend against Preprod"
	@echo "  make clean          # removes build artifacts"

install:
	$(PNPM) install

contracts:
	cd contracts && $(AIKEN) check

build: contracts
	$(PNPM) -r --filter ./offchain --filter ./backend --filter ./ui run build

test: contracts
	$(PNPM) -r --filter ./offchain --filter ./backend --filter ./ui run test

ui-dev:
	$(PNPM) --filter @lovejoin/ui run dev

backend-dev:
	$(PNPM) --filter @lovejoin/backend run dev

clean:
	rm -rf offchain/dist backend/dist ui/dist contracts/build crypto/ref/target
