// Generate end-to-end Mix fixtures with REAL sigma-OR proofs for
// [contracts/validators/mix_kat.test.ak].
//
// Why this is possible without a `serialise_data(List<Output>)` shim: the
// Mix ctx hashes only the N output datums, the N output values, and the mix
// script hash (never the full tx), so the TS prover can prove against a
// synthetic Aiken tx as long as both sides agree on those bytes. That makes
// these tests the strongest TS↔Aiken parity check for the Mix branch: if the
// box-value encoding (docs/generalize-lovejoin.md) or the datum encoding
// ever drifts, the positive tests fail.
//
// The proofs are built the way the SDK's `planMixTx` builds them (sorted
// inputs, output `permutation[i]` = `([y_i]·a_i, [y_i]·b_i)`, one ctx shared
// by all N proofs), from the SDK's own `computeMixCtx`,
// `serialiseMixDatumCanonical`, and `proveSigmaOr`. Only the box-value
// bytes are encoded locally, because the SDK's planner predates token pools.
//
// The negative tests reuse the same valid proofs and change one output's
// value. The ctx is built from the expected box value, not from the output,
// so the proofs still verify; only `mix_logic`'s exact box-value rule can
// reject those txs. Each negative therefore isolates that rule.
//
// Output: contracts/validators/mix_kat.test.ak (auto-generated; re-run via
// `pnpm --filter @lovejoin/sdk run gen:mix-kat`). Lives in validators/
// because Aiken lib modules cannot import validator modules.
//
// Determinism: every secret, rerandomizer, y_i, and permutation below is a
// fixed constant, and the prover's nonces are RFC 6979.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type DHTupleStatement,
  generator,
  pointFromBytes,
  pointToBytes,
  proveSigmaOr,
  type Scalar,
  scalarMul,
  type SigmaOrBranchProof,
  verifySigmaOr,
} from "../src/crypto/index.js";
import { computeMixCtx, serialiseMixDatumCanonical } from "../src/tx/mix.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

// ---------------------------------------------------------------------------
// Scenario constants: must match contracts/lib/lovejoin/test_fixtures.ak.
// ---------------------------------------------------------------------------

const MIX_SCRIPT_HASH = "55".repeat(28);

type BoxValue = {
  lovelace: bigint;
  token?: { policy: string; name: string; quantity: bigint };
};

// `default_reference_datum()`: 10 ADA boxes.
const ADA_BOX: BoxValue = { lovelace: 10_000_000n };
// `token_reference_datum()`: 2 ADA plus 1_000_000 of 0x34..34."TOKEN".
const TOKEN_BOX: BoxValue = {
  lovelace: 2_000_000n,
  token: { policy: "34".repeat(28), name: "544f4b454e", quantity: 1_000_000n },
};

const NS = [2, 3, 4];

interface Box {
  a: Uint8Array;
  b: Uint8Array;
}

interface Scenario {
  /** Inputs in ledger (sorted) order: box i sits at `out_ref(0xa0 + i, 0)`. */
  inputs: Box[];
  /** Outputs at tx positions 0..N-1. */
  outputs: Box[];
  /** `proofs[i]` is the proof for `inputs[i]`. */
  proofs: { branches: SigmaOrBranchProof[] }[];
}

/**
 * Canonical Plutus-Data CBOR of a box value: Aiken's
 * `builtin.serialise_data(value.box_value(..))`. Pinned against Aiken and
 * the Rust ref by the `box_value` vectors in encoding-parity.json.
 */
function encodeBoxValueCbor(value: BoxValue): Uint8Array {
  const uint = (n: bigint): number[] => {
    if (n < 24n) return [Number(n)];
    const [head, width] =
      n < 0x100n
        ? [0x18, 1]
        : n < 0x10000n
          ? [0x19, 2]
          : n < 0x1_0000_0000n
            ? [0x1a, 4]
            : [0x1b, 8];
    const out = [head];
    for (let i = width - 1; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
    return out;
  };
  const bytes = (h: string): number[] => {
    const b = Array.from(Buffer.from(h, "hex"));
    return [...(b.length < 24 ? [0x40 + b.length] : [0x58, b.length]), ...b];
  };
  const lovelace = [0x40, 0xa1, 0x40, ...uint(value.lovelace)];
  if (!value.token) return Uint8Array.from([0xa1, ...lovelace]);
  return Uint8Array.from([
    0xa2,
    ...lovelace,
    ...bytes(value.token.policy),
    0xa1,
    ...bytes(value.token.name),
    ...uint(value.token.quantity),
  ]);
}

function scenario(boxValue: BoxValue, n: number): Scenario {
  // Input i: a = [d_i]·g, b = [x_i]·a. Distinct x_i and d_i per box.
  const inputs: Box[] = [];
  for (let i = 0; i < n; i++) {
    const aPoint = scalarMul(BigInt(7 + 2 * i), generator());
    inputs.push({ a: pointToBytes(aPoint), b: pointToBytes(scalarMul(BigInt(1000 + i), aPoint)) });
  }
  const ys: Scalar[] = Array.from({ length: n }, (_, i) => BigInt(500 + i));
  // A rotation, so no input lands at its own index.
  const permutation = Array.from({ length: n }, (_, i) => (i + 1) % n);

  const outputs = new Array<Box>(n);
  for (let i = 0; i < n; i++) {
    outputs[permutation[i]!] = {
      a: pointToBytes(scalarMul(ys[i]!, pointFromBytes(inputs[i]!.a))),
      b: pointToBytes(scalarMul(ys[i]!, pointFromBytes(inputs[i]!.b))),
    };
  }

  const valueBytes = encodeBoxValueCbor(boxValue);
  const ctx = computeMixCtx({
    outputDatums: outputs.map((o) => serialiseMixDatumCanonical(o)),
    outputValues: outputs.map(() => valueBytes),
    mixScriptHashHex: MIX_SCRIPT_HASH,
  });
  const statements: DHTupleStatement[] = outputs.map((o) => ({
    ap: pointFromBytes(o.a),
    bp: pointFromBytes(o.b),
  }));
  const proofs = inputs.map((inp, i) => {
    const proof = proveSigmaOr(
      pointFromBytes(inp.a),
      pointFromBytes(inp.b),
      statements,
      permutation[i]!,
      ys[i]!,
      ctx,
    );
    if (!verifySigmaOr(pointFromBytes(inp.a), pointFromBytes(inp.b), statements, proof, ctx)) {
      throw new Error(`gen-mix-kat: local verification failed (N=${n}, input ${i})`);
    }
    return { branches: proof.branches };
  });
  return { inputs, outputs, proofs };
}

// ---------------------------------------------------------------------------
// Aiken emitters
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const lit = (b: Uint8Array): string => `#"${hex(b)}"`;

function emitScenario(kind: "ada" | "token", n: number, p: Scenario): string {
  const value = kind === "ada" ? "assets.from_lovelace(box_lovelace)" : "token_box_value()";
  const inputs = p.inputs
    .map((inp, i) =>
      [
        `    mix_box_input_with_value(`,
        `      0x${(0xa0 + i).toString(16)},`,
        `      0,`,
        `      ${lit(inp.a)},`,
        `      ${lit(inp.b)},`,
        `      ${value},`,
        `    ),`,
      ].join("\n"),
    )
    .join("\n");
  const outputs = p.outputs
    .map((o) =>
      [
        `    mix_box_output_with_value(`,
        `      ${lit(o.a)},`,
        `      ${lit(o.b)},`,
        `      ${value},`,
        `    ),`,
      ].join("\n"),
    )
    .join("\n");
  const proofs = p.proofs
    .map((proof) => {
      const branches = proof.branches
        .map((br) =>
          [
            `        SigmaOrBranch {`,
            `          t0: ${lit(br.t0)},`,
            `          t1: ${lit(br.t1)},`,
            `          c: ${lit(br.c)},`,
            `          z: ${lit(br.z)},`,
            `        },`,
          ].join("\n"),
        )
        .join("\n");
      return [`    SigmaOrProof {`, `      branches: [`, branches, `      ],`, `    },`].join("\n");
    })
    .join("\n");
  return `const ${kind}_n${n}_inputs: List<Input> =
  [
${inputs}
  ]

const ${kind}_n${n}_outputs: List<Output> =
  [
${outputs}
  ]

const ${kind}_n${n}_proofs: List<SigmaOrProof> =
  [
${proofs}
  ]
`;
}

function emit(): string {
  const scenarios: string[] = [];
  for (const kind of ["ada", "token"] as const) {
    for (const n of NS) {
      scenarios.push(emitScenario(kind, n, scenario(kind === "ada" ? ADA_BOX : TOKEN_BOX, n)));
    }
  }

  const positives = (["ada", "token"] as const)
    .flatMap((kind) =>
      NS.map(
        (n) => `test mix_real_proofs_${kind}_pool_n${n}_passes() {
  run_mix(${kind}_ref_input, ${kind}_n${n}_inputs, ${kind}_n${n}_outputs, ${kind}_n${n}_proofs)
}
`,
      ),
    )
    .join("\n");

  const benches = (["ada", "token"] as const)
    .flatMap((kind) =>
      NS.map(
        (n) => `bench mix_logic__mix__end_to_end_${kind}_pool_n${n}(_n: Int via const_unit) {
  run_mix(${kind}_ref_input, ${kind}_n${n}_inputs, ${kind}_n${n}_outputs, ${kind}_n${n}_proofs)
}
`,
      ),
    )
    .join("\n");

  return `//// AUTO-GENERATED by offchain/scripts/gen-mix-kat.ts.
//// Do NOT edit by hand. Re-run \`pnpm --filter @lovejoin/sdk run gen:mix-kat\`
//// to refresh.
////
//// End-to-end Mix fixtures with REAL sigma-OR proofs produced by the SDK's
//// TS prover, for an ADA pool (10 ADA boxes, \`default_reference_datum\`)
//// and a token pool (2 ADA + 1_000_000 TOKEN boxes, \`token_reference_datum\`)
//// at N = 2, 3, 4 (docs/generalize-lovejoin.md).
////
//// Positives: the validator recomputes the ctx from the outputs' datums,
//// the box value, and the mix script hash; the TS proofs verify only if
//// both sides agree on every byte.
////
//// Negatives: the same valid token-pool proofs against outputs whose value
//// is wrong. The ctx uses the expected box value, not the output's, so the
//// proofs still verify and only the exact box-value rule can reject.
////
//// Benches: full \`mix_logic\` runs (prologue plus all N sigma-OR verifies)
//// for both pool kinds, the token-pool cost check from the design doc's
//// "Risks" section.

use aiken/collection/list
use aiken/fuzz
use cardano/assets
use cardano/transaction.{Input, Output, Transaction}
use lovejoin/sigma_or.{SigmaOrBranch, SigmaOrProof}
use lovejoin/test_fixtures.{
  box_lovelace, default_reference_input, mix_box_input_with_value,
  mix_box_output_with_value, mix_script_hash, random_user_vk, ref_nft_name,
  ref_nft_policy, script_address, token_box_lovelace, token_box_value,
  token_name, token_policy, token_quantity, token_reference_input,
  vk_output_lovelace,
}
use lovejoin/types.{Mix}
use mix_logic

/// Run \`mix_logic\` on a Mix tx with the given mix outputs at positions
/// 0..N-1 followed by a non-mix change output.
fn run_mix(
  reference_input: Input,
  inputs: List<Input>,
  outputs: List<Output>,
  proofs: List<SigmaOrProof>,
) -> Bool {
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs },
    script_address(mix_script_hash).payment_credential,
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [reference_input],
      inputs,
      outputs: list.concat(
        outputs,
        [vk_output_lovelace(random_user_vk, 5_000_000)],
      ),
      fee: 200_000,
    },
  )
}

/// Replace the value of the first output.
fn with_first_value(outputs: List<Output>, value: assets.Assets) -> List<Output> {
  expect [first, ..rest] = outputs
  [Output { ..first, value }, ..rest]
}

/// Run the token-pool N=3 scenario with output 0's value replaced.
fn token_n3_with_first_value(value: assets.Assets) -> Bool {
  run_mix(
    token_ref_input,
    token_n3_inputs,
    with_first_value(token_n3_outputs, value),
    token_n3_proofs,
  )
}

fn const_unit(_size: Int) -> Fuzzer<Int> {
  fuzz.constant(0)
}

// Module constants are evaluated at compile time, so the fixtures below cost
// nothing at run time and the benches measure \`mix_logic\` alone (a real
// ScriptContext arrives as already-built data, too).
const ada_ref_input: Input = default_reference_input()

const token_ref_input: Input = token_reference_input()

${scenarios.join("\n")}
// ---------------------------------------------------------------------------
// Positive: real proofs verify end to end for both pool kinds.
// ---------------------------------------------------------------------------

${positives}
// ---------------------------------------------------------------------------
// Negative: the exact box-value rule, isolated (the proofs stay valid).
// ---------------------------------------------------------------------------

test mix_token_pool_rejects_output_with_wrong_quantity() fail {
  token_n3_with_first_value(
    assets.from_lovelace(token_box_lovelace)
      |> assets.add(token_policy, token_name, token_quantity - 1),
  )
}

test mix_token_pool_rejects_output_missing_token() fail {
  token_n3_with_first_value(assets.from_lovelace(token_box_lovelace))
}

test mix_token_pool_rejects_output_with_extra_token() fail {
  token_n3_with_first_value(
    token_box_value()
      |> assets.add(
          #"33333333333333333333333333333333333333333333333333333333",
          "junk",
          1,
        ),
  )
}

test mix_token_pool_rejects_output_with_extra_lovelace() fail {
  token_n3_with_first_value(
    assets.from_lovelace(token_box_lovelace + 1)
      |> assets.add(token_policy, token_name, token_quantity),
  )
}

test mix_token_pool_rejects_output_with_wrong_asset_name() fail {
  token_n3_with_first_value(
    assets.from_lovelace(token_box_lovelace)
      |> assets.add(token_policy, "TOKEM", token_quantity),
  )
}

test mix_token_pool_rejects_ada_pool_value() fail {
  // A 10 ADA ADA-pool box value is not this launch's box value.
  token_n3_with_first_value(assets.from_lovelace(box_lovelace))
}

test mix_token_pool_proofs_reject_under_ada_reference_datum() fail {
  // Same token-valued outputs and proofs, but the launch is the ADA pool:
  // the outputs no longer equal the box value, and the ctx would not match.
  run_mix(ada_ref_input, token_n3_inputs, token_n3_outputs, token_n3_proofs)
}

// ---------------------------------------------------------------------------
// Benchmarks: full validator runs (audit I-01 follow-up for token pools).
// ---------------------------------------------------------------------------

${benches}`;
}

const out = resolve(REPO_ROOT, "contracts/validators/mix_kat.test.ak");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, emit());
console.log(`wrote end-to-end Mix fixtures to ${out}`);
