//// Property-based tests for `expect_ada_only_lovelace`.
////
//// Audit F-19 (next-redeploy bundle Q-3): the function is small but
//// load-bearing — every Mix output and fee shard runs through it once.
//// The hand-written suite locks the canonical-shape pattern for a
//// handful of denominations; fuzzing widens coverage to:
////   * arbitrary positive ada amounts,
////   * native-asset injection (must abort),
////   * non-canonical ada asset name (must abort),
////   * ada policy with two asset-name entries (must abort),
////   * empty value (must abort).
////
//// Properties tested:
////   1. Ada-only Value at any positive lovelace round-trips through
////      `expect_ada_only_lovelace` and returns the lovelace amount.
////   2. Adding a native asset to an ada-only Value makes
////      `expect_ada_only_lovelace` abort.

use aiken/fuzz
use cardano/assets.{Value, ada_policy_id}
use lovejoin/value.{expect_ada_only_lovelace}

// `expect_ada_only_lovelace` aborts on non-canonical inputs. The positive
// path benefits from fuzzing over arbitrary lovelace amounts; the negative
// paths are pinned by unit tests below (the fuzzer's `fail` keyword on
// property tests means "find a counterexample where the property is
// false", which doesn't match "every input must abort").

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test prop_ada_only_round_trip(n via fuzz.int_between(1, 1_000_000_000_000)) {
  // assets.from_lovelace(n) is the canonical ada-only shape mix outputs use.
  // expect_ada_only_lovelace must extract n exactly.
  expect_ada_only_lovelace(assets.from_lovelace(n)) == n
}

// Negative paths exercise abort behaviour. aiken-lang/fuzz's `fail`
// keyword on property tests means "find a counterexample" — it doesn't
// match what we want here ("body must abort on every input"). So the
// negative tests below are unit tests that pin specific abort-prone
// shapes; the property test above (`prop_ada_only_round_trip`) is the
// one piece that genuinely benefits from fuzzing.

test rejects_native_asset_addition() fail {
  let v: Value =
    assets.from_lovelace(10_000_000)
      |> assets.add(
          #"00000000000000000000000000000000000000000000000000000001",
          "tok",
          1,
        )
  // expect_ada_only_lovelace must abort: pairs has 2 entries (ada + custom).
  // We compare to a fixed value to keep the call result on the stack —
  // `let _ = call` would be a dead-store and the optimiser would elide it.
  expect_ada_only_lovelace(v) == 10_000_000
}

test rejects_two_asset_names_under_ada() fail {
  // Add a non-canonical asset name under the ada policy. ada_assets now
  // has 2 entries; the strict pattern aborts.
  let v: Value =
    assets.from_lovelace(10_000_000)
      |> assets.add(ada_policy_id, "alt", 1)
  expect_ada_only_lovelace(v) == 10_000_000
}

test rejects_zero_value() fail {
  // assets.zero is the empty value — no policies. The
  // `expect [Pair(_, _)] = pairs` pattern aborts on the empty list.
  expect_ada_only_lovelace(assets.zero) == 0
}
