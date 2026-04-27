# 02 — Cryptography

## Curve choice: BLS12-381 G1

We use the prime-order subgroup of BLS12-381 G1 for all sigma protocols.

Rationale:

- **Plutus V3 builtins.** `bls12_381_G1_add`, `bls12_381_G1_scalar_mul`, `bls12_381_G1_compress`, `bls12_381_G1_uncompress`, `bls12_381_G1_equal`, `bls12_381_G1_hash_to_group`, `bls12_381_G1_neg` are all native — no library code in the script.
- **DDH is believed hard** in the prime-order subgroup (the cofactor is handled by `uncompress` which subgroup-checks).
- **Compressed encoding is 48 bytes**, vs G2's 96 bytes. Smaller datums = smaller min-UTxO.
- **Scalar multiplication is cheap** in G1 relative to G2.

We do **not** use pairings; Sigmajoin doesn't need them.

### Parameters

- `r` = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001 (255-bit prime, order of G1's prime subgroup)
- `g` = canonical generator (compressed):
  `0x97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb`

Scalar serialization is 32 bytes, big-endian, with the constraint that the canonical bytes encode a value strictly less than `r`.

## Primitives

### Schnorr / proveDlog

Statement: prover knows `x ∈ Z_r` such that `u = [x]g`.

Non-interactive (Fiat-Shamir):
1. Prover picks `r_p ∈ Z_r` uniformly, computes `t = [r_p]g`.
2. Computes challenge `c = H(g, u, t, ctx) mod r`.
3. Computes `z = r_p + c·x mod r`.
4. Sends proof `π = (t, z)`.

Verifier: accept iff `[z]g == t + [c]u`.

Generalized form `proveDlog(g', u)` (any base): same as above with `g` replaced by `g'`. Used for the Owner branch with `g' = a`, `u = b`.

### proveDHTuple

Statement: prover knows `x ∈ Z_r` such that `u = [x]g` AND `v = [x]h`, for given `(g, h, u, v)`.

Non-interactive:
1. Prover picks `r_p ∈ Z_r`, computes `(t_0, t_1) = ([r_p]g, [r_p]h)`.
2. `c = H(g, h, u, v, t_0, t_1, ctx) mod r`.
3. `z = r_p + c·x mod r`.
4. Proof `π = (t_0, t_1, z)`.

Verifier: accept iff `[z]g == t_0 + [c]u` AND `[z]h == t_1 + [c]v`.

In the Mix branch we use `g = a, h = b, u = a', v = b'` and the witness is the mixer's secret `y` such that `(a', b') = ([y]a, [y]b)`.

### N-way Sigma-OR (paper Appendix C, generalized)

Statement: prover knows a witness for **at least one** of N statements `τ_0, τ_1, ..., τ_{N-1}` where each `τ_i = proveDHTuple(a, b, a'_i, b'_i)`.

Without loss of generality the prover knows the witness `y` for branch `b ∈ {0, ..., N-1}`.

#### Prover

1. **Real branch (`b`):**
   - pick `r_p ∈ Z_r`, set `(t_{b,0}, t_{b,1}) = ([r_p]a, [r_p]b)`.

2. **Simulated branches (each `i ≠ b`):**
   - pick `c_i ∈ {0,1}^{256}` uniformly (32 bytes).
   - pick `z_i ∈ Z_r` uniformly.
   - set `t_{i,0} = [z_i]a - [c_i mod r]a'_i`.
   - set `t_{i,1} = [z_i]b - [c_i mod r]b'_i`.

3. **Combined challenge:**
   - `c = H(a, b, a'_0, b'_0, ..., a'_{N-1}, b'_{N-1}, t_{0,0}, t_{0,1}, ..., t_{N-1,0}, t_{N-1,1}, ctx)` — 32-byte hash output.
   - `c_b = c XOR (XOR_{i ≠ b} c_i)` — that is, the real branch's challenge is the XOR-completion of all simulated challenges with respect to the global `c`.

4. **Real branch response:** `z_b = r_p + (c_b mod r)·y mod r`.

5. **Proof:** `π = ((t_{i,0}, t_{i,1}, c_i, z_i) for i = 0..N-1)`.

#### Verifier

- Recompute `c = H(...)` over all public elements + all `t_{i,*}` + ctx.
- Check `c == XOR_{i=0..N-1} c_i` (bytewise).
- For each `i ∈ {0..N-1}`: check
  - `[z_i]a == t_{i,0} + [c_i mod r]a'_i`,
  - `[z_i]b == t_{i,1} + [c_i mod r]b'_i`.

If any branch fails, reject.

#### Cost summary

For an N-way OR proof:

| Item | Count |
|---|---|
| `t_{i,0}`, `t_{i,1}` | 2N × 48 bytes |
| `c_i`, `z_i` | N × 64 bytes |
| Total proof size | `~ 160·N` bytes |
| Verifier scalar muls | 2N |
| Verifier adds | 2N (subtractions are add+neg) |
| Verifier hash | 1 blake2b-256 over all the above |

The N=2 case reduces to the standard 2-way Cramer-Damgård OR.

#### When prover knows multiple witnesses

In our Mix tx, the mixer knows `y_b` for *one* of the N branches per input (the branch where the i-th input was mapped to). The above construction handles exactly this case. If the mixer happened to know witnesses for multiple branches (they don't in our protocol; only one branch per input is "real"), they'd just pick one to be `b` and simulate the rest.

## Hash function and Fiat-Shamir context binding

`H` is **blake2b-256** (Plutus builtin: `blake2b_256`). Output length 32 bytes.

The hash input is a canonically serialized byte string:

```
H( DOMAIN_TAG_v1
 || statement_id           // 1 byte: 0x01 = proveDlog, 0x02 = proveDHTuple, 0x03 = sigma-or-N
 || N                      // 1 byte: only for sigma-or-N; encodes the number of branches
 || all public group elements, in compressed (48-byte) form, in fixed order
 || all commitment values t_*, in compressed form, in fixed order
 || ctx                    // context-binding string
)
```

Domain tag: `"lovejoin/sigmajoin/v1/"` (ASCII).

### Context binding (`ctx`)

The proof MUST commit to enough of the spending transaction that an attacker cannot replay or front-run it.

#### Owner redeemer
```
ctx = blake2b_256( serialize(tx.outputs) || mixScriptHash )
```

#### Mix redeemer (variable N)
```
ctx = blake2b_256(
    serialize(out_0.datum) || serialize(out_1.datum) || ... || serialize(out_{N-1}.datum)
 || serialize(out_0.value) || serialize(out_1.value) || ... || serialize(out_{N-1}.value)
 || mixScriptHash
)
```

This binds the proof to the *exact* N output mix-boxes, preventing rebinding to a different output set.

## Nonce generation: RFC 6979 deterministic

The per-proof nonce `r_p` (and the simulator's `c_i, z_i` for each `i ≠ b` in sigma-OR) are derived **deterministically** from `(secretKey, message)` via HMAC-SHA256, per **RFC 6979**.

```
r_p = HMAC-SHA256-DRBG( seed = secretKey || H(message) || domain_tag || counter )
```

`counter` increments if the derived value is `0 mod r` (negligibly likely).

### Why deterministic is safer here, not weaker

- An attacker who can predict `r_p` extracts the secret. RFC 6979 makes `r_p` the output of HMAC-SHA256 keyed by the secret. Predicting it requires breaking HMAC-SHA256 (a PRF). Out of reach.
- Removes the failure mode where a broken / weak / predictable RNG silently leaks secrets — the catastrophe Sony PS3, Bitcoin Android wallet bug, and many others fell to.
- KAT vectors become exact: same `(x, message)` always produces the same proof bytes.

### Where CSPRNG is still needed

The **secret key itself** (`x` in a deposit, `y_i` in a mix) MUST come from a CSPRNG. Browser: `crypto.getRandomValues`. Node: `crypto.randomBytes`. RFC 6979 protects per-proof nonces; it does not generate secret keys.

## Test vectors

KAT files in `crypto/test-vectors/`:
- `provedlog.json` — 1000 vectors at default form.
- `provedhtuple.json` — 1000 vectors.
- `sigma-or.json` — vectors at N ∈ {2, 3, 4, 6, 8}, 200 each.
- `negative.json` — invalid proofs that MUST fail (across all N).

Each vector verified by:
1. The TS prover (re-derive proof using RFC 6979 nonce; assert exact bytes).
2. The TS verifier.
3. The Aiken validator running in the simulator.
4. An independent Rust reference (`blst`) for the prover side.

## What we don't do

- We don't use Pedersen commitments (no value hiding).
- We don't use pairings or BLS signatures.
- We don't use Bulletproofs / range proofs.
- We don't use any non-standard or experimental crypto. Every primitive is textbook Schnorr / sigma-protocols.
