//// Shared transaction-fixture helpers for validator tests.
////
//// These helpers are NOT used by validators; they exist so tests can construct
//// synthetic `Transaction` values cheaply and consistently. Production validator
//// code reads the same fields but never *constructs* them.
////
//// All construction is deterministic — every byte / address / value is named so
//// that diffs between fixtures are obvious. No randomness.

use aiken/primitive/bytearray as aiken_bytearray
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference}
use lovejoin/types.{MixDatum, ProtocolParams, ReferenceDatum, ReferenceParams}

// ---------------------------------------------------------------------------
// Reusable byte-array constants
// ---------------------------------------------------------------------------

pub const ref_nft_policy: ByteArray =
  #"abababababababababababababababababababababababababababab"

pub const ref_nft_name: ByteArray = "lovejoin"

pub const reference_holder_hash: ByteArray =
  #"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"

pub const mix_script_hash: ByteArray =
  #"55555555555555555555555555555555555555555555555555555555"

pub const mix_logic_hash: ByteArray =
  #"66666666666666666666666666666666666666666666666666666666"

pub const fee_script_hash: ByteArray =
  #"77777777777777777777777777777777777777777777777777777777"

pub const random_user_vk: ByteArray =
  #"99999999999999999999999999999999999999999999999999999999"

pub const denom_lovelace: Int = 10_000_000

pub const max_fee_per_mix_lovelace: Int = 800_000

pub const max_n: Int = 6

pub const fee_shard_target: Int = 10

// 48-byte BLS12-381 G1 generator and another point we trust to be on the curve.
// (Both are real points from the M1 KAT vectors.)
pub const a48: ByteArray =
  #"97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb"

pub const b48: ByteArray =
  #"a572cbea904d67468808c8eb50a9450c9721db309128012543902d0ac358a62ae28f75bb8f1c7c42c39a8c5529bf0f4e"

pub const c48: ByteArray =
  #"89ece308f9d1f0131765212deca99697b112d61f9be9a5f1f3780a51335b3ff981747a0b2ca2179b96d2c0c9024e5224"

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

pub fn default_protocol_params() -> ProtocolParams {
  ProtocolParams {
    denom_lovelace: denom_lovelace,
    max_fee_per_mix_lovelace: max_fee_per_mix_lovelace,
    max_n: max_n,
    mix_script_hash: mix_script_hash,
    mix_logic_script_hash: mix_logic_hash,
    fee_script_hash: fee_script_hash,
    fee_shard_target: fee_shard_target,
  }
}

pub fn default_reference_params() -> ReferenceParams {
  ReferenceParams { reference_nft_policy: ref_nft_policy, reference_nft_name: ref_nft_name }
}

pub fn default_reference_datum() -> ReferenceDatum {
  ReferenceDatum { protocol: default_protocol_params() }
}

// ---------------------------------------------------------------------------
// OutputReference / Input / Output builders
// ---------------------------------------------------------------------------

pub fn out_ref(byte: Int, idx: Int) -> OutputReference {
  // Cheap unique-ish ids: a 32-byte string filled with `byte`, plus an index.
  OutputReference {
    transaction_id: replicate_byte(byte, 32),
    output_index: idx,
  }
}

pub fn replicate_byte(b: Int, n: Int) -> ByteArray {
  // Tail-recursive constructor for short bytestrings. Aiken's stdlib doesn't ship
  // a `replicate` for ByteArray, but `bytearray.from_int_big_endian` plus a fold
  // would also work — the explicit recursion is clearer.
  do_replicate(b, n, #"")
}

fn do_replicate(b: Int, n: Int, acc: ByteArray) -> ByteArray {
  if n == 0 {
    acc
  } else {
    do_replicate(b, n - 1, aiken_bytearray.push(acc, b))
  }
}

pub fn script_address(hash: ByteArray) -> Address {
  Address { payment_credential: Script(hash), stake_credential: None }
}

pub fn vk_address(hash: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(hash), stake_credential: None }
}

pub fn script_credential(hash: ByteArray) -> Credential {
  Script(hash)
}

// ---------------------------------------------------------------------------
// Reference-input fixture
// ---------------------------------------------------------------------------

/// An Input that holds the reference NFT and an InlineDatum carrying the
/// supplied `ProtocolParams`. Use this in `reference_inputs` of a synthetic tx.
pub fn reference_input_with(params: ProtocolParams) -> Input {
  let datum: Data = ReferenceDatum { protocol: params }
  Input {
    output_reference: out_ref(0xee, 0),
    output: Output {
      address: script_address(reference_holder_hash),
      value: assets.add(
        assets.from_lovelace(2_000_000),
        ref_nft_policy,
        ref_nft_name,
        1,
      ),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

/// Default reference input using the default ProtocolParams.
pub fn default_reference_input() -> Input {
  reference_input_with(default_protocol_params())
}

// ---------------------------------------------------------------------------
// Mix-box fixtures
// ---------------------------------------------------------------------------

pub fn mix_box_input(
  ref_byte: Int,
  ref_idx: Int,
  a: ByteArray,
  b: ByteArray,
  lovelace: Int,
) -> Input {
  let datum: Data = MixDatum { a, b }
  Input {
    output_reference: out_ref(ref_byte, ref_idx),
    output: Output {
      address: script_address(mix_script_hash),
      value: assets.from_lovelace(lovelace),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

pub fn mix_box_output(a: ByteArray, b: ByteArray, lovelace: Int) -> Output {
  let datum: Data = MixDatum { a, b }
  Output {
    address: script_address(mix_script_hash),
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

pub fn mix_box_output_with_value(
  a: ByteArray,
  b: ByteArray,
  value: Value,
) -> Output {
  let datum: Data = MixDatum { a, b }
  Output {
    address: script_address(mix_script_hash),
    value: value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

pub fn mix_box_input_bad_datum(ref_byte: Int, ref_idx: Int, datum: Data) -> Input {
  Input {
    output_reference: out_ref(ref_byte, ref_idx),
    output: Output {
      address: script_address(mix_script_hash),
      value: assets.from_lovelace(denom_lovelace),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

// ---------------------------------------------------------------------------
// Fee-shard fixtures
// ---------------------------------------------------------------------------

pub fn fee_shard_input(ref_byte: Int, ref_idx: Int, lovelace: Int) -> Input {
  let unit: Data = Void
  Input {
    output_reference: out_ref(ref_byte, ref_idx),
    output: Output {
      address: script_address(fee_script_hash),
      value: assets.from_lovelace(lovelace),
      datum: InlineDatum(unit),
      reference_script: None,
    },
  }
}

pub fn fee_shard_output(lovelace: Int) -> Output {
  let unit: Data = Void
  Output {
    address: script_address(fee_script_hash),
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(unit),
    reference_script: None,
  }
}

pub fn fee_shard_output_no_datum(lovelace: Int) -> Output {
  Output {
    address: script_address(fee_script_hash),
    value: assets.from_lovelace(lovelace),
    datum: NoDatum,
    reference_script: None,
  }
}

// ---------------------------------------------------------------------------
// Generic ada-only output helper (e.g. user change)
// ---------------------------------------------------------------------------

pub fn vk_output_lovelace(vk: ByteArray, lovelace: Int) -> Output {
  Output {
    address: vk_address(vk),
    value: assets.from_lovelace(lovelace),
    datum: NoDatum,
    reference_script: None,
  }
}
