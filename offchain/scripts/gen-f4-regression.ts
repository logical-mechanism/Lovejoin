// Generate the F-4 (Owner ctx ↔ input_refs binding) negative-regression
// fixtures consumed by [contracts/validators/mix_logic.test.ak].
//
// Why this needs a generator (not hand-coded literals):
//   The Aiken on-chain test runs the validator's real ctx computation:
//
//     ctx = blake2b_256(
//       serialise_data(self.outputs)
//         || serialise_data(self.inputs[].output_reference)
//         || mix_script_hash
//     )
//
//   For the *positive* control to pass, the TS-side prover must compute a
//   Schnorr proof π against EXACTLY those bytes. We pick a minimal scenario
//   (empty outputs, single input ref) so both sides agree on byte-equal
//   ctx without dragging in mesh / CST. Then the *F-4 negative* sibling
//   test reuses π verbatim against a tx whose only input ref differs —
//   the validator's recomputed ctx no longer matches and Schnorr verify
//   rejects.
//
// Output: contracts/validators/f4_regression_kat.test.ak (auto-generated;
// re-run via `pnpm --filter @lovejoin/sdk run gen:f4-regression`). Lives
// in validators/ rather than lib/ because Aiken disallows lib modules
// from importing validator modules — we need the `mix_logic` import to
// drive the on-chain rule.
//
// Determinism: secret + input refs + outputs + mix_script_hash are all
// fixed constants below; RFC 6979 makes Schnorr proving deterministic
// over (base, secret, ctx).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { blake2b256 } from "../src/crypto/hash.js";
import { generator, pointToBytes, scalarMul, type Scalar } from "../src/crypto/bls.js";
import { proveSchnorr, verifySchnorr } from "../src/crypto/schnorr.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

// ---------------------------------------------------------------------------
// Scenario constants — must match the Aiken test fixtures byte-for-byte.
// ---------------------------------------------------------------------------

// Test mix_script_hash from contracts/lib/lovejoin/test_fixtures.ak.
const MIX_SCRIPT_HASH = hex2bytes("55".repeat(28));

// Owner secret. (Any 1 ≤ x < r works; pick a small constant.)
const OWNER_SECRET: Scalar = 0x42n;

// Two distinct input refs that share the same (a, b) box. The replay
// scenario: a malicious depositor posts box₂ with the same (a, b) as box₁;
// when the owner withdraws box₁, the attacker copies the proof to spend
// box₂. Pre-fix: ctx is identical (depends only on outputs); proof verifies
// against box₂ too. Post-fix: ctx mixes input_refs → distinct ctxs → proof
// fails.
const REF_TXID_1 = "aa".repeat(32);
const REF_TXID_2 = "bb".repeat(32);
const REF_INDEX_1 = 0;
const REF_INDEX_2 = 0;

// outputs = [] → canonical Plutus-Data CBOR is `0x80` (definite-length
// empty array). Pinned by the empty-list probe; matches Aiken canonical.
const OUTPUTS_BYTES = hex2bytes("80");

// ---------------------------------------------------------------------------
// Hand-rolled canonical Plutus-Data CBOR for serialise_data([OutputReference]).
// Mirrors offchain/scripts/gen-encoding-parity.ts exactly. The output_refs
// parity tests lock byte-equality with Aiken's `builtin.serialise_data`.
// ---------------------------------------------------------------------------

function serializeOutputRefList(refs: { txId: string; outputIndex: number }[]): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x9f)];
  for (const r of refs) parts.push(serializeOutputRef(r.txId, BigInt(r.outputIndex)));
  parts.push(Uint8Array.of(0xff));
  return concat(parts);
}

function serializeOutputRef(txIdHex: string, outputIndex: bigint): Uint8Array {
  const txId = hex2bytes(txIdHex);
  if (txId.length !== 32) throw new Error("tx id must be 32 bytes");
  return concat([
    Uint8Array.of(0xd8, 0x79, 0x9f),
    encodeBytes(txId),
    encodeMinorInt(outputIndex),
    Uint8Array.of(0xff),
  ]);
}

function encodeMinorInt(v: bigint): Uint8Array {
  if (v < 0n) throw new Error("non-negative ints only");
  if (v < 24n) return Uint8Array.of(Number(v));
  if (v < 0x100n) return Uint8Array.of(0x18, Number(v));
  if (v < 0x10000n) {
    const n = Number(v);
    return Uint8Array.of(0x19, (n >> 8) & 0xff, n & 0xff);
  }
  throw new Error("output_index too large for this generator (extend if needed)");
}

function encodeBytes(b: Uint8Array): Uint8Array {
  const len = b.length;
  if (len < 24) return concat([Uint8Array.of(0x40 + len), b]);
  if (len < 0x100) return concat([Uint8Array.of(0x58, len), b]);
  throw new Error("byte string too long for this generator");
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compute ctx + Schnorr proof.
// ---------------------------------------------------------------------------

function computeCtx(outputsBytes: Uint8Array, inputRefsBytes: Uint8Array): Uint8Array {
  const preimage = new Uint8Array(
    outputsBytes.length + inputRefsBytes.length + MIX_SCRIPT_HASH.length,
  );
  preimage.set(outputsBytes, 0);
  preimage.set(inputRefsBytes, outputsBytes.length);
  preimage.set(MIX_SCRIPT_HASH, outputsBytes.length + inputRefsBytes.length);
  return blake2b256(preimage);
}

// (a, b) for the duplicate-(a,b) box — base = generator, secret = OWNER_SECRET.
const aPoint = generator();
const bPoint = scalarMul(OWNER_SECRET, aPoint);
const aBytes = pointToBytes(aPoint);
const bBytes = pointToBytes(bPoint);

const inputRefsBytes1 = serializeOutputRefList([{ txId: REF_TXID_1, outputIndex: REF_INDEX_1 }]);
const inputRefsBytes2 = serializeOutputRefList([{ txId: REF_TXID_2, outputIndex: REF_INDEX_2 }]);

const ctx1 = computeCtx(OUTPUTS_BYTES, inputRefsBytes1);
const ctx2 = computeCtx(OUTPUTS_BYTES, inputRefsBytes2);

// Sanity: the F-4 fix means ctx1 != ctx2.
if (bytes2hex(ctx1) === bytes2hex(ctx2)) {
  throw new Error("F-4 generator: ctx1 == ctx2; the binding is broken");
}

const proof1 = proveSchnorr(aPoint, OWNER_SECRET, ctx1);

// Sanity: π verifies against ctx1 and FAILS against ctx2.
if (!verifySchnorr(aPoint, bPoint, proof1, ctx1)) {
  throw new Error("F-4 generator: positive control failed (proof should verify against ctx1)");
}
if (verifySchnorr(aPoint, bPoint, proof1, ctx2)) {
  throw new Error("F-4 generator: replay against ctx2 succeeded (binding is broken)");
}

// ---------------------------------------------------------------------------
// Emit the Aiken test file.
// ---------------------------------------------------------------------------

function aikenLiteral(b: Uint8Array): string {
  return `#"${bytes2hex(b)}"`;
}

const aikenSrc = `//// AUTO-GENERATED by offchain/scripts/gen-f4-regression.ts.
//// Do NOT edit by hand. Re-run \`pnpm --filter @lovejoin/sdk run gen:f4-regression\`
//// to refresh.
////
//// F-4 (audit-2026-05-03): the Owner Schnorr ctx now binds to
//// \`self.inputs[].output_reference\` so a proof signed against one input
//// set cannot be replayed against a different input set that happens to
//// share \`(a, b)\`.
////
//// These tests use a minimal byte-equivalent scenario:
////   * outputs = []  →  serialise_data([]) = 0x80
////   * mix_script_hash = ${aikenLiteral(MIX_SCRIPT_HASH)}
////   * (a, b) = (g, [${OWNER_SECRET}]·g)  — the same box appears at two refs
////   * proof π is generated by the TS prover (RFC 6979 deterministic) against
////     ctx_1 = blake2b_256(0x80 || serialise_data([ref_1]) || mix_script_hash).
////
//// Test 1 (positive): tx with ref_1 as the sole input → validator's ctx
//// matches what π was signed against → schnorr.verify accepts.
//// Test 2 (F-4 replay): tx with ref_2 as the sole input (same (a, b)) →
//// validator's ctx differs → schnorr.verify rejects.

use cardano/transaction.{Transaction}
use lovejoin/schnorr.{SchnorrProof}
use lovejoin/test_fixtures.{
  default_reference_input, denom_lovelace, mix_box_input, mix_script_hash,
  ref_nft_name, ref_nft_policy, script_address,
}
use lovejoin/types.{Owner}
use mix_logic

// (a, b) — duplicate-(a,b) shared by the two boxes at distinct input refs.
const a_bytes: ByteArray =
  ${aikenLiteral(aBytes)}

const b_bytes: ByteArray =
  ${aikenLiteral(bBytes)}

// Real Schnorr proof for ctx_1 = blake2b_256(0x80 || serialise_data([ref_1]) || mix_script_hash).
const proof_t: ByteArray =
  ${aikenLiteral(proof1.t)}

const proof_z: ByteArray =
  ${aikenLiteral(proof1.z)}

fn pi() -> SchnorrProof {
  SchnorrProof { t: proof_t, z: proof_z }
}

// Single mix-box input at ref_1 = (#"aa..aa", 0).
fn input_at_ref_1() -> Transaction {
  Transaction {
    ..transaction.placeholder,
    reference_inputs: [default_reference_input()],
    inputs: [mix_box_input(0xaa, 0, a_bytes, b_bytes, denom_lovelace)],
    outputs: [],
    fee: 200_000,
  }
}

// Single mix-box input at ref_2 = (#"bb..bb", 0). Same (a, b) as ref_1's
// box — the duplicate-(a,b) replay scenario.
fn input_at_ref_2() -> Transaction {
  Transaction {
    ..transaction.placeholder,
    reference_inputs: [default_reference_input()],
    inputs: [mix_box_input(0xbb, 0, a_bytes, b_bytes, denom_lovelace)],
    outputs: [],
    fee: 200_000,
  }
}

// ---------------------------------------------------------------------------
// Positive control — proof verifies against the original input ref.
// Anchors the TS↔Aiken byte-equal ctx; if this test ever fails, the F-4
// binding has drifted (or serialise_data on List<OutputReference> has).
// ---------------------------------------------------------------------------

test owner_real_proof_at_ref_1_passes() {
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Owner { proofs: [pi()] },
    script_address(mix_script_hash).payment_credential,
    input_at_ref_1(),
  )
}

// ---------------------------------------------------------------------------
// F-4 negative regression — replay against the duplicate-(a, b) box at a
// different ref must reject. Validator's recomputed ctx mixes the new ref
// into the preimage; the previously-valid proof no longer verifies.
// ---------------------------------------------------------------------------

test owner_proof_replay_against_duplicate_ab_at_ref_2_rejects() fail {
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Owner { proofs: [pi()] },
    script_address(mix_script_hash).payment_credential,
    input_at_ref_2(),
  )
}
`;

const out = resolve(REPO_ROOT, "contracts/validators/f4_regression_kat.test.ak");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, aikenSrc);
console.log(`wrote F-4 regression test to ${out}`);
console.log(`  ctx_1 = ${bytes2hex(ctx1)}`);
console.log(`  ctx_2 = ${bytes2hex(ctx2)}`);
console.log(`  proof.t = ${bytes2hex(proof1.t)}`);
console.log(`  proof.z = ${bytes2hex(proof1.z)}`);

// ---------------------------------------------------------------------------
// Local utilities
// ---------------------------------------------------------------------------

function hex2bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytes2hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
