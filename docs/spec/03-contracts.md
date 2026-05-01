# 03 — Contracts (Aiken)

Four validators, one minting policy:

1. **`reference_holder`** (§1) — always-False, holds the protocol NFT and ProtocolParams datum. The hyperstructure anchor.
2. **`one_shot_mint`** (§1) — minting policy parameterized by a seed UTxO. Mints exactly one NFT, exactly once.
3. **`mix_box`** (§2) — spend validator at the pooled UTxO address. **Trivial pass-through**: requires that `mix_logic` runs (withdraw-zero pattern) when the datum is well-formed, and returns True for missing/malformed datums (hyperstructure recovery).
4. **`mix_logic`** (§2) — **withdrawal validator** that runs once per tx and contains the actual mix/owner logic: Owner branch (Schnorr) + Mix branch (variable-N sigma-OR). Inputs arrive lexicographically sorted by `(txid, idx)`, and the redeemer carries proofs in that order.
5. **`fee_contract`** (§3) — shared fee pool sharded across ~10 UTxOs. Two redeemer paths: PayMixFee, Replenish.

`mix_logic` and `fee_contract` are parameterized **only by the reference NFT identifier**. At validation time they look up the reference UTxO via `tx.reference_inputs` and read the protocol parameters. `mix_box` is parameterized by the `mix_logic` script credential directly (so it can do the withdraw-zero check without a reference lookup). Variable N for Mix is determined at runtime from the tx structure.

We pin **Aiken 1.1.21**.

## §0 — Hyperstructure principles

Two design rules thread through every spend validator below; they're called out once here so the per-validator sections stay focused on the protocol logic.

### Rule 1 — withdraw-zero delegation

Cardano runs spending validators **once per script input**. A naive Mix tx with N=6 mix-box inputs would run `mix_box`'s spend logic 6 times, redoing the same work (filter inputs, filter outputs, decode protocol params, set up ctx, …). That overhead alone — independent of the OR-proof verification — is a major contributor to the per-tx CPU budget that gates `max_n`.

The standard Cardano workaround (used by Seedelf, JPG, Levvy, MinSwap, etc.) is the **withdraw-zero trick**:

1. Register a stake credential pointing to a **withdrawal validator** (`mix_logic`).
2. Each spending validator only checks that `tx.withdrawals` contains an entry for that credential (typically with amount 0).
3. The withdrawal validator runs **once per tx** and contains the real logic.

The spending validator's per-input cost drops to roughly "is this credential in withdrawals" (a `Pairs.get_first` on a small map), and the heavy work happens once. For our N=6 case, this swaps `6× (decode + filter + ctx + verify-one-OR-proof)` for `6× (cheap delegation) + 1× (decode + filter + ctx + verify-six-OR-proofs)` — same total proof work, much less overhead.

### Rule 2 — bad / missing datums are accepted

Spend validators in lovejoin return **True** when the input's datum is missing or doesn't decode to the expected shape. The intent is hyperstructure-coherent: the protocol publishes rules for _its_ datums; UTxOs that someone else parked at the script address with a junk datum are not the protocol's concern, and the protocol shouldn't decide their fate by making assumptions about what they "meant."

Concrete consequences:

- `mix_box` spend: missing datum or bytes that don't decode as `MixDatum {a: 48 bytes, b: 48 bytes, a ≠ b}` → True. Anyone can sweep these UTxOs. They were never part of the privacy pool.
- `fee_contract` spend: datum that isn't `()` → True. Same recovery semantics.
- `reference_holder` spend: **always False** — this is intentional and is _not_ a Rule-2 case. The reference UTxO is the hyperstructure anchor; the fact that no one (including a malformed-datum spender) can move it is the property we want.

The withdrawal validator (`mix_logic`) is not bound by Rule 2 the same way: it doesn't run on a per-UTxO basis but on the tx as a whole. It silently **ignores** mix-script inputs whose datums don't decode (those inputs go through the spend validator's True branch independently). It still strictly validates the well-formed inputs and all outputs at the mix address.

This combination is safe against the obvious attack — including someone else's valid mix-box alongside junk-datum decoys to bypass proof requirements — because every well-formed input still triggers `mix_box`'s withdraw-zero check, which forces `mix_logic` to run, which forces a valid OR-proof or Schnorr proof for that input.

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
  mix_logic_script_hash: ByteArray, // withdraw-zero validator (§2)
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

## §2 — `mix_box` (spend) and `mix_logic` (withdraw)

### Datum (`mix_box`)

```aiken
type MixDatum {
  a: ByteArray,    // 48 bytes, compressed G1
  b: ByteArray,    // 48 bytes, compressed G1
}
```

A datum is **well-formed** iff: it decodes as `MixDatum`, `bytearray.length(a) == 48`, `bytearray.length(b) == 48`, and `a != b`. We do **not** call `bls12_381_g1_uncompress` in well-formedness checks — that's expensive and the proof verifiers already do it.

Inline datums only on outputs the protocol creates.

### Redeemers

```aiken
type SchnorrProof {
  t: ByteArray,    // 48 bytes
  z: ByteArray,    // 32 bytes
}

type SigmaOrBranch {
  t0: ByteArray,   // 48 bytes
  t1: ByteArray,   // 48 bytes
  c:  ByteArray,   // 32 bytes  -- raw FS challenge component
  z:  ByteArray,   // 32 bytes
}

type SigmaOrProof {
  branches: List<SigmaOrBranch>,    // length must equal N at runtime
}

type MixLogicRedeemer {
  Owner { proof: SchnorrProof }
  Mix   { proofs: List<SigmaOrProof> }    // one per well-formed mix input, in input-sort order
}
```

The spending validator's redeemer is `Void` — `mix_box` doesn't dispatch; everything happens in `mix_logic`.

### `mix_box` validator (spend; pass-through)

```aiken
validator mix_box(mix_logic_credential: Credential) {
  spend(datum: Option<Data>, _r: Data, _utxo: OutputReference, self: Transaction) {
    when try_decode_well_formed_mix_datum(datum) is {
      // Well-formed: must run mix_logic via withdraw-zero.
      Some(_) ->
        // Search self.withdrawals (sorted Pairs<Credential, Lovelace>).
        // Amount can be anything (typically 0).
        pairs.has_key(self.withdrawals, mix_logic_credential)

      // Missing or malformed datum: hyperstructure recovery — accept.
      None ->
        True
    }
  }
}
```

### `mix_logic` validator (withdraw; the heavy logic)

```aiken
validator mix_logic(ref: ReferenceParams) {
  withdraw(redeemer: MixLogicRedeemer, _account: Credential, self: Transaction) {
    let params = read_protocol_params(self, ref)
    let own_hash = params.mix_script_hash

    // Filter inputs at the mix script. Inputs are already sorted lexicographically
    // by (txid, output_index) by the ledger; this preserves that order.
    let mix_inputs_all =
      self.inputs |> list.filter(fn (i) { input_at_script(i, own_hash) })

    // Decode datums; silently drop malformed inputs (Rule 2 — those go via spend's True branch).
    let mix_inputs =
      mix_inputs_all |> list.filter_map(decode_well_formed)

    // Output rules are strict — we are creating these UTxOs.
    let mix_outputs =
      self.outputs |> list.filter(fn (o) { output_at_script(o, own_hash) })

    when redeemer is {
      Owner { proof } -> validate_owner(mix_inputs, proof, self, own_hash)
      Mix   { proofs } -> validate_mix(mix_inputs, mix_outputs, proofs, params, own_hash)
    }
  }
}
```

### Owner branch

Rules:

1. Exactly **one** well-formed mix input.
2. Schnorr verify against `(a, b)` of that input with
   `ctx = blake2b_256(serialize(self.outputs) || mix_script_hash)`.

No signer requirement (Schnorr proof binds to outputs; output substitution invalidates).

### Mix branch — variable N

Rules (all enforced; each gets a positive + negative test):

1. `N = length(mix_inputs)`, with `2 <= N <= params.max_n`.
2. `length(mix_outputs) == N`, and the N mix outputs occupy positions 0..N−1 of `self.outputs`.
3. Each mix output: `value.lovelace == params.denom_lovelace`, no native assets, inline `MixDatum` well-formed (`a' ≠ b'`, lengths == 48).
4. `length(proofs) == N`. Proof at index `i` is for the i-th sorted mix input.
5. `ctx = blake2b_256(`
   `   serialize(out_0.datum) || ... || serialize(out_{N-1}.datum)`
   `|| serialize(out_0.value) || ... || serialize(out_{N-1}.value)`
   `|| mix_script_hash)`.
   Note: the fee-contract output is **not** hashed (its value depends on `tx.fee`, which depends on proof size — circular).
6. For each `i ∈ {0..N-1}`: N-way sigma-OR for input `i` verifies against
   `(a_i, b_i, [(out_0.a, out_0.b), ..., (out_{N-1}.a, out_{N-1}.b)])` with `ctx`.

**Output ordering and privacy.** The validator does _not_ enforce a specific permutation of outputs at positions 0..N−1; the SDK randomizes. Privacy is provided by the OR-proof's mathematical indistinguishability across the N output set, not by validator-enforced ordering. Randomizing the output positions defeats positional-heuristic linkage by passive observers.

### Performance budget (N-dependent, withdraw-zero)

The total cryptographic work for a Mix tx is unchanged: N proofs × 2N branches each = `2N²` scalar muls. What changes is the **overhead**: instead of running `mix_box`'s heavy spend validator N times (decode, filter, ctx, verify-one-proof), we run the cheap pass-through N times plus `mix_logic` once.

Per-tx cost components:

| Component                      | Count | Notes                                           |
| ------------------------------ | ----- | ----------------------------------------------- |
| `mix_box` spend (pass-through) | N     | tiny — a `Pairs.has_key` and a datum decode     |
| `mix_logic` withdraw           | 1     | one ctx, one ref-utxo decode, N OR-proof checks |
| `fee_contract` spend           | 1     | unchanged                                       |

The `2N²` proof work concentrates in `mix_logic`. The M2 stress test calibrates real CPU on Preprod and sets `max_n` accordingly. Initial bet (post-design-update): `max_n = 6`, with realistic upside to `max_n = 8` if the per-input overhead reduction is significant. We commit empirical numbers to `docs/perf.md`.

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
  spend(datum: Option<Data>, redeemer: FeeRedeemer, utxo: OutputReference, self: Transaction) {
    // Rule 2: bad / missing datum → True (recovery path; UTxOs that someone
    // accidentally parked here without () are not the protocol's concern).
    when datum is {
      None -> True
      Some(d) ->
        if !is_unit_datum(d) {
          True
        } else {
          let params = read_protocol_params(self, ref)
          let own_hash = own_script_hash(utxo, self)
          expect own_hash == params.fee_script_hash

          when redeemer is {
            PayMixFee -> validate_pay_mix_fee(params, self, utxo, own_hash)
            Replenish -> validate_replenish(self, utxo, own_hash)
          }
        }
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

Bootstrap order matters because of the cross-references between scripts:

```
$ ./build.sh contracts/config/network.test.json
  Reads config; produces seed UTxO id from bootstrap wallet.
  Computes (in order):
    1. one_shot_mint  policy_id  (parameterized by seed)
    2. reference_holder script hash  (no params)
    3. mix_logic   script hash  (parameterized by NFT policy + name)
    4. mix_box     script hash  (parameterized by mix_logic credential)
    5. fee_contract script hash  (parameterized by NFT policy + name)
  Writes artifacts/<network>/{*.plutus, addresses.json}.
  addresses.json carries every hash above plus the ProtocolParams datum
  that 01-mint-and-lock.sh will inline-attach to the reference UTxO.
```

## §5 — Why Owner has no signer requirement

The Schnorr proof is bound to `serialize(tx.outputs)` via Fiat-Shamir. The proof can ONLY authorize the exact output configuration it was built for. Mempool extraction is harmless: an attacker re-submitting the same tx still pays the legitimate destination. Output substitution invalidates the proof.

Removing `bound_pkh` simplifies the redeemer and matches Seedelf's spending pattern.

## §6 — Collateral handling at the contract level

Cardano requires collateral for any Plutus tx. The contracts themselves don't reference the collateral input — Cardano enforces it transparently. From the validator's perspective, collateral is invisible.

But the _tx-builder_ must provide one. For Mix txs, the SDK uses an external **collateral provider service** (e.g. giveme.my). For Deposit and Withdraw, the user's own wallet supplies collateral (since the wallet is in the tx anyway).

The fee_contract validator does not need to validate collateral specifically; it only checks `tx.fee` and the shard's value diff. The collateral mechanism is a Cardano protocol feature, not a contract feature.

## §7 — Test plan summary

See [07-testing.md](07-testing.md). Highlights:

- KAT vectors at N ∈ {2, 3, 4, 6, 8}.
- Each `mix_box` rule has positive + negative tests at multiple N values.
- Each `fee_contract` rule has positive + negative tests.
- `reference_holder` cannot be spent.
- Mix-tx stress test calibrates `MAX_FEE_PER_MIX` AND `max_n` empirically.
- Fuzz: 30-min nightly run.
