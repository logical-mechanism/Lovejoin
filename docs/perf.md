# Lovejoin performance log

This file is the canonical, append-only record of empirical numbers from the
M2 stress tests (`stress-tests/{max-n-calibration,fee-calibration}.ts`) and any
follow-on benchmarks. The recommendations here back the values committed into
`config/network.preprod.json`.

## M2 follow-ups (open)

These are deliberately deferred from the initial M2 work; they are blockers
for marking M2 fully `done`.

1. **Run `infra/bootstrap/{00,01,02,03}-*.sh` against Preprod.** Needs:
   * a Preprod wallet seeded with ~50 ADA for the bootstrap + reference
     scripts + fee shards,
   * `BLOCKFROST_PROJECT_ID_PREPROD` for `cardano-cli` submission and SDK
     queries,
   * a stake key for the `mix_logic` credential (the same address's stake
     key is fine).
   On success, commit the populated `artifacts/preprod/addresses.json`
   (referenceNftPolicy, referenceUtxoRef, all four script hashes, the fee
   shard array, the reference-script UTxO map). Until this happens M2's
   exit criteria #5 (`addresses.json has reference NFT info`) cannot pass.

2. **Run `stress-tests/max-n-calibration.ts` once M4's Mix tx builder lands.**
   Until M4 the runner is a stub that aborts with a clear "needs M4" notice;
   the data-flow + output schema (`docs/perf.md` table + `network.preprod.json`
   `max_n`) is fixed so M4's drop-in is a small change.

3. **Run `stress-tests/fee-calibration.ts`** — same gating as above; output
   is the `max_fee_per_mix_lovelace` value committed into `network.preprod.json`.

4. **Run `stress-tests/fuzz-runner.ts -d 30m`** for the 30-minute fuzz that
   M2 exit criterion #9 requires. Status writes to
   `tests/fuzz/last-run-status.txt` (`PASS` / `FAIL`). Same M4 gating.

5. **Encoding-parity helper for `serialise_data(List<Output>)`** so the
   Aiken-side proof-positive tests (Owner branch with real Schnorr proof,
   Mix branch with real OR proofs at N ∈ {2,3,4,6,8}) can be authored. The
   structural rule coverage already lives in
   `contracts/validators/{mix_logic,fee_contract,…}.test.ak`; what's missing
   is a TS-side `serialise_data` matching Aiken's Plutus-Data CBOR exactly so
   the prover can compute the same `ctx` the validator does. See
   `contracts/validators/mix_logic.test.ak` ("What's deferred to a follow-up
   commit").

Once items 1–4 produce numbers, append the calibration runs below in
chronological order.

## M3 — mesh viability assessment (2026-04-27)

**Question:** can `@meshsdk/core@1.8.14`'s `MeshTxBuilder` build the three
Lovejoin tx shapes — Deposit, Withdraw, and (the harder one) Mix?

**Method:** static read of mesh's TS surface against the spec's tx
diagrams (docs/spec/01-protocol.md), plus type-level wiring in
`offchain/src/tx/{deposit,withdraw}.ts` against `MeshTxBuilder`'s
fluent API. No Preprod submission yet — that is the M3 integration
test's job, not the SDK module's.

**Findings:**

| Shape             | mesh fit | Notes |
|-------------------|----------|-------|
| Deposit           | clean    | `txIn` (script, fee shard, Replenish) + `txOut` (mix-box, fee replen) + `selectUtxosFrom` (wallet) + `txInCollateral` (wallet) covers it. Reference inputs via `readOnlyTxInReference`. CIP-33 reference scripts via `spendingTxInReference`. |
| Withdraw          | clean    | Adds the withdraw-zero leg (`withdrawalPlutusScriptV3` + `withdrawal(rewardAddr, "0")` + `withdrawalRedeemerValue` + `withdrawalTxInReference`). Mix-box spend uses an unused `Void`-shaped redeemer (mesh requires *some* CBOR; we pass `d87980`). Two-pass build to bind the Schnorr proof to final outputs is straightforward — same redeemer size on both passes keeps fee + outputs stable. |
| Mix (deferred M4) | **unverified — biggest open risk** | The unconventional shape (no submitter wallet input, externally-supplied collateral input + key witness, exact-fee constraint linking shard input value to shard output value via `tx.fee`) is exactly the case spec build-guide §Risk 2 calls out. mesh's `txInCollateral` accepts a UTxO ref + amount + address but the witness for the collateral input must come via the wallet's `signTx` path; we need a way to inject an externally-pre-signed `VkeyWitness` directly. Path forward: (a) check whether mesh's `appendWitness` / `setSigners` accepts a raw vkey witness; (b) if not, switch to lucid-evolution before going deep on M4 Mix. Resolved at M4 start. |

**Decision (M3 close):** mesh stays. Deposit + withdraw are buildable
with mesh's first-class API. Mix viability is M4's first test.

**Encoding parity for `serialise_data(self.outputs)`:** the Withdraw
Schnorr proof's `ctx` requires a TS encoder that byte-matches Aiken's
`builtin.serialise_data`. We rely on mesh's CST bindings
(`@meshsdk/core-cst`) inside `tx/withdraw.ts`'s `serializeOutputsForCtx`
helper — see the comment block there. The Preprod integration test on
Withdraw is the parity test; if it fails with "Schnorr verify rejected"
on a tx whose math is correct, that helper is the single point of
failure to debug.

