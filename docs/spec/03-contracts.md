# 03 — Contracts (Aiken)

Three validators, one minting policy:

1. **`reference_holder`** (§1) — always-False, holds the protocol NFT and ProtocolParams datum. The hyperstructure anchor.
2. **`one_shot_mint`** (§1) — minting policy parameterized by a seed UTxO. Mints exactly one NFT, exactly once.
3. **`mix_box`** (§2) — pooled UTxO validator. Owner branch (Schnorr) + Mix branch (variable-N sigma-OR).
4. **`fee_contract`** (§3) — shared fee pool sharded across ~10 UTxOs. Two redeemer paths: PayMixFee, Replenish.

`mix_box` and `fee_contract` are parameterized **only by the reference NFT identifier**. At spend time they look up the reference UTxO via `tx.reference_inputs` and read the protocol parameters. Variable N for Mix is determined at runtime from the tx structure.

We pin **Aiken 1.1.21**.

## Repository layout

```
contracts/
  aiken.toml
  config/
    network.test.json
    network.preprod.json
  lib/
    lovejoin/
      types.ak                # MixDatum, MixRedeemer, FeeRedeemer, ProtocolParams, SigmaOrProof
      bls.ak
      hash.ak
      schnorr.ak              # proveDlog verifier
      dhtuple.ak              # proveDHTuple verifier
      sigma_or.ak             # N-way sigma-OR verifier (variable N)
      reference.ak            # reference UTxO lookup helpers
      mixbox.ak
      fee.ak
  validators/
    reference_holder.ak
    one_shot_mint.ak
    mix_box.ak
    fee_contract.ak
  test/
    crypto_test.ak
    reference_test.ak
    mix_box_test.ak           # tests at N ∈ {2, 3, 4, 6}
    fee_contract_test.ak
  build.sh
```

## §1 — Reference holder + one-shot mint

### Protocol parameters

```aiken
type ProtocolParams {
  denom_lovelace: Int,
  max_fee_per_mix_lovelace: Int,
  max_n: Int,                       // upper bound on Mix tx width, e.g. 6
  mix_script_hash: ByteArray,
  fee_script_hash: ByteArray,
  fee_shard_target: Int,
}

type ReferenceDatum {
  protocol: ProtocolParams,
}
```

### Reference holder validator

```aiken
validator reference_holder {
  spend(_d: Option<Data>, _r: Data, _utxo: OutputReference, _self: Transaction) {
    False
  }
}
```

The UTxO is unspendable; data is permanent. UTxOs referenced via `reference_inputs` are read but not consumed and the validator does not execute, so the always-False is defense-in-depth.

### One-shot mint policy

```aiken
validator one_shot_mint(seed: OutputReference) {
  mint(_r: Data, policy_id: PolicyId, self: Transaction) {
    expect list.has(self.inputs |> list.map(fn (i) { i.output_reference }), seed)
    let minted_quantity =
      self.mint
        |> assets.tokens(policy_id)
        |> dict.foldr(0, fn (_name, qty, acc) { qty + acc })
    expect minted_quantity == 1
    True
  }
}
```

The seed UTxO is consumed in the same tx as the mint; the policy can fire at most once.

### Bootstrap sequence

`infra/bootstrap/`:

```
00-build-reference.sh         # derives all hashes from config
01-mint-and-lock.sh           # consumes seed, mints NFT, locks at reference_holder
02-fund-fee-contract.sh       # creates 10 fee shards
03-publish-reference-scripts.sh  # CIP-33 reference scripts
```

After bootstrap, `addresses.<network>.json` holds: NFT `policy_id` + `asset_name`, reference script addresses, all script hashes, reference UTxO ref.

## §2 — `mix_box` validator

### Datum

```aiken
type MixDatum {
  a: ByteArray,    // 48 bytes
  b: ByteArray,    // 48 bytes
}
```

Validator rejects: `a` or `b` of length ≠ 48; `a == b`; `uncompress(a)` or `uncompress(b)` failing.

Inline datums only.

### Redeemer (variable-N sigma-OR; no `bound_pkh`)

```aiken
type SchnorrProof {
  t: ByteArray,    // 48 bytes
  z: ByteArray,    // 32 bytes
}

type SigmaOrBranch {
  t0: ByteArray,   // 48 bytes
  t1: ByteArray,   // 48 bytes
  c:  ByteArray,   // 32 bytes
  z:  ByteArray,   // 32 bytes
}

type SigmaOrProof {
  branches: List<SigmaOrBranch>,    // length must equal N at runtime
}

type MixRedeemer {
  Owner { proof: SchnorrProof }
  Mix   { proof: SigmaOrProof }
}
```

### Validator skeleton

```aiken
type ReferenceParams {
  reference_nft_policy: ByteArray,
  reference_nft_name:   ByteArray,
}

validator mix_box(ref: ReferenceParams) {
  spend(datum: Option<MixDatum>, redeemer: MixRedeemer, utxo: OutputReference, self: Transaction) {
    expect Some(d) = datum
    expect 48 == bytearray.length(d.a)
    expect 48 == bytearray.length(d.b)
    expect d.a != d.b

    let params = read_protocol_params(self, ref)

    when redeemer is {
      Owner { proof } -> validate_owner(d, proof, self, utxo)
      Mix   { proof } -> validate_mix(d, proof, self, utxo, params)
    }
  }
}
```

### `validate_owner`

```
ctx = blake2b_256(serialize(self.outputs) || own_script_hash)
verify schnorr proof against (a, b) with ctx-bound challenge
```

No signer required.

### `validate_mix` — variable N

```
1. mix_inputs  = self.inputs.filter(addr.script_credential == own_script_hash)
   N = length(mix_inputs)
   expect 2 <= N <= params.max_n
2. mix_outputs = self.outputs.filter(addr.script_credential == own_script_hash)
   expect length(mix_outputs) == N
   expect mix_outputs are at the first N positions of self.outputs (positions 0..N-1)
3. For each mix output:
   a. value.lovelace == params.denom_lovelace, no native assets
   b. inline datum well-formed MixDatum, a' ≠ b'
4. expect length(proof.branches) == N
5. ctx = blake2b_256(
        serialize(out_0.datum) || ... || serialize(out_{N-1}.datum)
     || serialize(out_0.value) || ... || serialize(out_{N-1}.value)
     || own_script_hash )
6. Verify N-way sigma-OR proof against
       (a, b, [out_0.a, out_0.b, out_1.a, out_1.b, ..., out_{N-1}.a, out_{N-1}.b])
   with ctx
```

The validator runs once per mix-input. Each instance verifies its own N-way OR proof from its own redeemer. All instances see the same outputs and therefore compute the same `ctx`.

### Performance budget (N-dependent)

Per `validate_mix` run: `2N` scalar muls, `2N` adds, `~3N` uncompresses, blake2b for ctx + FS challenge, plus reference-UTxO lookup.

Per Mix tx (N inputs all running): `2N²` scalar muls total.

| N | Per-script CPU est. | Per-tx CPU est. | Headroom vs mainnet ~10M/tx |
|---|---|---|---|
| 2 | ~0.5M | ~1M (+ fee+ref) | comfortable |
| 4 | ~1M | ~4M | comfortable |
| 6 | ~1.5M | ~9M | tight |
| 8 | ~2M | ~16M | over budget |

These are estimates. The M2 stress test calibrates real numbers and sets `max_n` accordingly. Initial bet: `max_n = 6`. We adjust based on benchmark.

## §3 — `fee_contract` validator

### Sharding

The fee contract is a logical pool of `fee_shard_target` UTxOs (canonical: 10). At bootstrap we create exactly 10. Both PayMixFee and Replenish preserve the shard count (each consumes one shard input and produces one shard output). The SDK and backend select shards uniformly at random.

### Datum & redeemer

```aiken
type FeeDatum  = ()
type FeeRedeemer { PayMixFee, Replenish }
```

### Validator

```aiken
validator fee_contract(ref: ReferenceParams) {
  spend(_d: Option<FeeDatum>, redeemer: FeeRedeemer, utxo: OutputReference, self: Transaction) {
    let params = read_protocol_params(self, ref)
    let own_hash = own_script_hash(utxo, self)
    expect own_hash == params.fee_script_hash

    when redeemer is {
      PayMixFee -> validate_pay_mix_fee(params, self, utxo, own_hash)
      Replenish -> validate_replenish(self, utxo, own_hash)
    }
  }
}
```

### `validate_pay_mix_fee`

1. ≥ 2 inputs at `params.mix_script_hash`.
2. Exactly one fee input (`own_hash`), and it's `utxo`.
3. Exactly one fee output at `own_hash`, datum unchanged.
4. `fee_in.lovelace - fee_out.lovelace == self.fee`.
5. `self.fee ≤ params.max_fee_per_mix_lovelace`.
6. No native assets in fee input/output.

### `validate_replenish`

1. Exactly one fee input (`own_hash`), and it's `utxo`.
2. Exactly one fee output at `own_hash`, datum unchanged.
3. `fee_out.lovelace > fee_in.lovelace` (strict).
4. No native assets.

## §4 — Compile / parameterize / hash

```
$ ./build.sh contracts/config/network.test.json
  Reads config; produces seed UTxO id from bootstrap wallet.
  Computes:
    - one_shot_mint policy_id (parameterized by seed)
    - reference_holder script hash
    - mix_box script hash       (parameterized by NFT policy + name)
    - fee_contract script hash  (parameterized by NFT policy + name)
  Writes artifacts/test/{*.plutus, addresses.json}.
```

## §5 — Why Owner has no signer requirement

The Schnorr proof is bound to `serialize(tx.outputs)` via Fiat-Shamir. The proof can ONLY authorize the exact output configuration it was built for. Mempool extraction is harmless: an attacker re-submitting the same tx still pays the legitimate destination. Output substitution invalidates the proof.

Removing `bound_pkh` simplifies the redeemer and matches Seedelf's spending pattern.

## §6 — Collateral handling at the contract level

Cardano requires collateral for any Plutus tx. The contracts themselves don't reference the collateral input — Cardano enforces it transparently. From the validator's perspective, collateral is invisible.

But the *tx-builder* must provide one. For Mix txs, the SDK uses an external **collateral provider service** (e.g. giveme.my). For Deposit and Withdraw, the user's own wallet supplies collateral (since the wallet is in the tx anyway).

The fee_contract validator does not need to validate collateral specifically; it only checks `tx.fee` and the shard's value diff. The collateral mechanism is a Cardano protocol feature, not a contract feature.

## §7 — Test plan summary

See [07-testing.md](07-testing.md). Highlights:

- KAT vectors at N ∈ {2, 3, 4, 6, 8}.
- Each `mix_box` rule has positive + negative tests at multiple N values.
- Each `fee_contract` rule has positive + negative tests.
- `reference_holder` cannot be spent.
- Mix-tx stress test calibrates `MAX_FEE_PER_MIX` AND `max_n` empirically.
- Fuzz: 30-min nightly run.
