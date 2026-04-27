# 04 — Off-chain library

## Package layout

```
offchain/
  package.json
  tsconfig.json
  src/
    crypto/
      bls.ts             # @noble/curves/bls12-381 wrappers
      hash.ts            # blake2b-256 + FS hash construction (matches contract)
      nonce.ts           # RFC 6979 deterministic nonce derivation
      schnorr.ts         # prover for proveDlog
      dhtuple.ts         # prover for proveDHTuple
      sigma_or.ts        # N-way sigma-OR prover
      verify.ts          # verifier mirror
    tx/
      params.ts          # loads addresses.json, fetches reference UTxO
      deposit.ts         # buildDepositTx (mix-box + fee replenishment)
      mix.ts             # buildMixTx (variable N, fee shard, collateral provider)
      withdraw.ts        # buildWithdrawTx (Schnorr proof, no signer for box)
      fee.ts             # shard selection helpers
      collateral.ts      # collateral provider client (giveme.my by default)
    wallet/
      cip30.ts
      mnemonic.ts
    pool/
      client.ts          # backend API client
      identify.ts        # given x, find your boxes
      select.ts          # uniform random N-tuple selection for mixing
    cli/
      index.ts
  test/
    kat/
    e2e/
```

Published as `@lovejoin/sdk`.

## Dependencies

| Package | Purpose |
|---|---|
| `@noble/curves` | BLS12-381 G1 ops |
| `@noble/hashes` | blake2b, hmac (RFC 6979) |
| `@meshsdk/core` | tx building, CIP-30 |
| `@cardano-ogmios/client` | optional direct chain access |
| `cbor-x` | datum CBOR (must match Aiken's) |
| `vitest` | tests |

## Crypto module

### `bls.ts`

```ts
export type Scalar = Uint8Array;       // 32 bytes, < r
export type G1Point = Uint8Array;      // 48 bytes, compressed

export const G: G1Point;
export function randomScalar(): Scalar;
export function scalarMul(p: G1Point, k: Scalar): G1Point;
export function add(p: G1Point, q: G1Point): G1Point;
export function neg(p: G1Point): G1Point;
export function eq(p: G1Point, q: G1Point): boolean;
export function isOnCurveAndInSubgroup(p: G1Point): boolean;
```

### `nonce.ts`

```ts
export function deriveNonce(secretKey: Scalar, message: Uint8Array, counter: number): Scalar;
```

RFC 6979 HMAC-SHA256-DRBG. Per-proof nonces, simulator challenges, and simulator responses are all derived deterministically.

### `sigma_or.ts` — N-way prover

```ts
export type SigmaOrProof = {
  branches: Array<{ t0: G1Point; t1: G1Point; c: Uint8Array; z: Scalar }>;
};

export function proveSigmaOr(args: {
  a: G1Point;
  b: G1Point;
  outputs: Array<{ a: G1Point; b: G1Point }>;   // length = N
  realBranchIndex: number;                       // which branch the prover knows
  witness: Scalar;                               // y_i for the real branch
  ctx: Uint8Array;
}): SigmaOrProof;

export function verifySigmaOr(args: {
  a: G1Point; b: G1Point;
  outputs: Array<{ a: G1Point; b: G1Point }>;
  proof: SigmaOrProof;
  ctx: Uint8Array;
}): boolean;
```

For the real branch: standard Schnorr commit/respond.
For each other branch: simulate via random `(c_i, z_i)` and back-solved `t_{i,*}`.
The real branch's challenge is the XOR-completion of all simulated challenges with respect to `c = H(transcript || ctx)`.

## Reference parameters loader

```ts
type LovejoinAddresses = {
  network: "preprod" | "mainnet";
  referenceNftPolicy: string;
  referenceNftAssetName: string;
  referenceUtxoRef: TxOutRef;
  mixScriptAddress: string;
  feeScriptAddress: string;
  mixScriptHash: string;
  feeScriptHash: string;
};

type ProtocolParams = {
  denomLovelace: bigint;
  maxFeePerMixLovelace: bigint;
  maxN: number;                  // 2 ≤ N ≤ maxN per Mix tx
  feeShardTarget: number;
};

export async function loadAddresses(network: string): Promise<LovejoinAddresses>;
export async function fetchProtocolParams(addresses: LovejoinAddresses, provider: Provider): Promise<ProtocolParams>;
```

The reference UTxO is immutable; `fetchProtocolParams` caches for the SDK session.

## Collateral provider client

```ts
// tx/collateral.ts

export interface CollateralProvider {
  // Request a collateral input + return output for an upcoming tx.
  // The returned partial tx fragment is incorporated into the user's tx.
  requestCollateral(args: {
    txBodyDigest: Uint8Array;     // hash of the mostly-built tx body
    collateralAmountLovelace: bigint;
  }): Promise<{
    collateralInput: TxInput;     // the provider's UTxO
    collateralReturn: TxOutput;   // where the collateral goes if scripts succeed
    providerSignature: Uint8Array; // pre-signed witness for the collateral
  }>;
}

export class GivemeMyProvider implements CollateralProvider {
  constructor(opts: { endpoint?: string; apiKey?: string });
  requestCollateral(args): Promise<...>;
}

export class WalletProvider implements CollateralProvider {
  // Fall-back for Deposit and Withdraw txs where the user's wallet
  // is already in the tx; uses CIP-30 to source collateral from the wallet.
  constructor(wallet: CIP30Wallet);
}
```

Default for Mix txs: `GivemeMyProvider` against `https://giveme.my` (or its current endpoint). The service is free.
Default for Deposit and Withdraw: `WalletProvider` — fine because the user's wallet is in the tx anyway.
Both are pluggable; users can configure a custom Mix provider.

**Mix txs require a collateral provider.** If `GivemeMyProvider` (or whatever's configured) is unreachable, the SDK throws an error and the Mix tx is not built. There is no default `WalletProvider` fallback for Mix because that would defeat the wallet-anonymity property — submitter's wallet becomes the collateral signer, and tracking becomes trivial.

A user who deliberately wants to use wallet-collateral for a Mix tx can do so by explicitly passing `collateralProvider: new WalletProvider(wallet)` in the call. This is an advanced override, not a default behavior, and the UI does not surface it.

## Pool helpers

### Owning-box identification

```ts
export function ownsBox(myX: Scalar, datum: MixDatum): boolean {
  const xa = scalarMul(datum.a, myX);
  return eq(xa, datum.b);
}
```

### Random N-tuple selection

```ts
export function pickRandomNTuple(pool: PoolEntry[], n: number, options?: {
  excludeRefs?: TxOutRef[];
}): PoolEntry[];
```

`n` clamped to `min(n, pool.size)`. Uniform random sample without replacement.

## Tx builders

### `buildDepositTx`

```ts
export async function buildDepositTx(args: {
  network: "preprod" | "mainnet";
  ownerSecret?: Scalar;
  rounds: number;
  walletInputs: UTxO[];
  changeAddress: string;
  provider: ChainProvider;
}): Promise<{ tx: TxComplete; secret: Scalar; secretLabel: string }>;
```

Output 0: mix-box `(g, [x]g)`. Output 1: replenished fee shard. Output 2+: change.
Collateral: from the user's wallet.

### `buildMixTx` — variable N + collateral provider

```ts
export async function buildMixTx(args: {
  network: "preprod" | "mainnet";
  n?: number;                                  // default = max_n from config (clamped to pool.size)
  boxes?: Array<{ ref: TxOutRef; datum: MixDatum }>;  // optional explicit selection; otherwise random
  provider: ChainProvider;
  collateralProvider?: CollateralProvider;     // default = GivemeMyProvider
}): Promise<TxComplete>;
```

Internally:
1. If `boxes` is omitted, pick `n` random pool boxes.
2. Pick a fee shard.
3. Generate fresh `y_0, ..., y_{n-1}`.
4. Compute output datums: `out_i = ([y_i]a_i, [y_i]b_i)` for each input `i`. Then permute the output indices uniformly at random.
5. Compute `mixCtx` from output datums and values + script hash.
6. Construct n-way sigma-OR proof for *each* of the n inputs (each prover knows the witness for the branch where its input went).
7. Build tx skeleton: n mix-box inputs + 1 fee shard input → n mix outputs + 1 fee shard output.
8. Request collateral from provider; insert collateral input + collateral return.
9. Submit. The collateral provider's signature is the only key witness.

The mesh layer needs to support: (a) building txs with no submitter wallet input, (b) accepting an externally-supplied collateral input + signature, (c) computing fees iteratively to converge `tx.fee == shard_in - shard_out`. Confirm at M3 start (OQ-E); fall back to lucid-evolution if blocked.

### `buildWithdrawTx`

```ts
export async function buildWithdrawTx(args: {
  network: "preprod" | "mainnet";
  ownerSecret: Scalar;
  myBoxRef: TxOutRef;
  myBoxDatum: MixDatum;
  destinationAddress: string;       // can be a Seedelf address
  feeWalletInputs: UTxO[];
  changeAddress: string;
  provider: ChainProvider;
}): Promise<TxComplete>;
```

Build skeleton, compute `txOutputsHash`, generate Schnorr proof, insert into redeemer. Wallet signs its inputs. Collateral from the wallet.

## CLI

```
$ lovejoin deposit --rounds 30
$ lovejoin mix                       # uses max_n
$ lovejoin mix --n 4                 # explicit width
$ lovejoin mix --rounds 5 --n 6
$ lovejoin withdraw --secret ./box-1.secret --to addr1...
```

## Wallet integration & key storage

Same as before — encrypted IndexedDB with Argon2id, modeled on Lace/Eternl/Nami patterns. Wallet keys ≠ box ownership keys, repeated clearly in UI.

## Encoding parity tests

Single test file `test/encoding-parity.spec.ts` generates 1000 random `MixDatum` and `MixValue` instances at varied N, serializes them, and hashes them with `fsChallenge`. The Aiken test suite does the same; harness diffs the byte outputs. Mismatch = build-blocker.
