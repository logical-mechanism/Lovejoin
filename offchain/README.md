# offchain (`@lovejoin/sdk`)

TypeScript SDK for Lovejoin: BLS sigma-protocol prover, transaction builders (deposit, withdraw, mix), CIP-30 wallet helpers, collateral-provider client, and a `ChainProvider` abstraction with a Blockfrost implementation.

Spec: [docs/spec/04-offchain.md](../docs/spec/04-offchain.md). The README is a quickstart; the spec is canonical.

## What's here

```
src/
  crypto/      bls, hash, nonce (RFC 6979), schnorr, dhtuple, sigma_or (variable-N).
  chain/       provider.ts (interface), blockfrost.ts, backend.ts, backend-mesh.ts.
  tx/          deposit, withdraw, mix, fee, collateral, params, mesh-bridge, witness-merge.
  pool/        identify (find live mix-boxes), select (sample N for a mix).
  wallet/      cip30 connector, seed (deterministic vault from wallet signData).
  cli/         small Node CLI entrypoint (`pnpm cli`).
test/          vitest suites mirroring the src/ layout.
scripts/       gen-{schnorr,dhtuple,sigmaor,negative,encoding-parity}-kat.ts.
```

## Public exports surface

The package re-exports four module groups from [src/index.ts](src/index.ts):

| Group      | What you get                                                              | Spec section |
| ---------- | ------------------------------------------------------------------------- | ------------ |
| `crypto/*` | `proveSchnorr`, `verifySchnorr`, `proveDHTuple`, `proveSigmaOr`, BLS ops. | §02          |
| `chain/*`  | `ChainProvider` interface, `BlockfrostProvider`, `BackendProvider`.       | §04          |
| `tx/*`     | `buildDepositTx`, `buildWithdrawTx`, `buildMixTx`, `CollateralProvider`.  | §04          |
| `wallet/*` | `connectCip30`, `deriveVaultSeed`, owner-secret HKDF helpers.             | §04, §06     |
| `pool/*`   | `findMixBoxes`, `selectMixSet` (uniform random N of M).                   | §04          |

## Use `@lovejoin/sdk` from another project

It is a workspace package today, not yet on npm. From another monorepo workspace:

```ts
import {
  BlockfrostProvider,
  buildDepositTx,
  buildWithdrawTx,
  GivemeMyProvider,
} from "@lovejoin/sdk";

const chain = new BlockfrostProvider({
  projectId: process.env.BLOCKFROST_PROJECT_ID_PREPROD!,
  network: "preprod",
});
const params = await chain.getProtocolParams();
const tx = await buildDepositTx({ chain, params /* ...wallet inputs... */ });
```

The SDK never calls Blockfrost directly outside `BlockfrostProvider`. New chain capabilities go on the [`ChainProvider`](src/chain/provider.ts) interface so the self-hosted backend can grow a matching implementation.

## KAT vectors

Cross-language Known-Answer-Tests live in [`crypto/test-vectors/`](../crypto/test-vectors/). Each vector verifies in (1) the TS prover, (2) the TS verifier, (3) the Aiken validator, and (4) the Rust reference. Negative vectors must be rejected by all three verifiers.

Regenerate them with:

```sh
pnpm --filter @lovejoin/sdk gen:kat        # all four sets
pnpm --filter @lovejoin/sdk gen:schnorr-kat
pnpm --filter @lovejoin/sdk gen:dhtuple-kat
pnpm --filter @lovejoin/sdk gen:sigmaor-kat
pnpm --filter @lovejoin/sdk gen:negative-kat
pnpm --filter @lovejoin/sdk gen:parity     # TS↔Aiken CBOR-encoding parity vectors
```

Generators are deterministic. Re-running on the same inputs produces byte-identical JSON.

## Day-to-day

```sh
pnpm --filter @lovejoin/sdk build         # tsc → dist/
pnpm --filter @lovejoin/sdk test          # vitest run
pnpm --filter @lovejoin/sdk typecheck
pnpm --filter @lovejoin/sdk lint          # tsc + eslint
pnpm --filter @lovejoin/sdk cli -- ...    # tsx src/cli/index.ts
```

The repo-root `make test`, `make build`, `make lint` are the umbrella entry points and run this workspace alongside `backend` and `ui`. The `make cli`, `make deposit`, `make withdraw` targets in the root `Makefile` wrap the CLI with `.env` loaded.

## Risk note

The Fiat-Shamir challenge and `MixDatum` CBOR are computed in both TS (here) and Aiken (the validator). One byte of disagreement silently breaks every Mix on chain. The `gen:parity` script and [test/crypto/encoding-parity.test.ts](test/crypto/encoding-parity.test.ts) exist to catch that. Run them before changing any serialization. See [docs/spec/12-build-guide.md](../docs/spec/12-build-guide.md) §"Risk 1".
