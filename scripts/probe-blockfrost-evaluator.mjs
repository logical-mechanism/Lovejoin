// Direct probe of Blockfrost's tx-evaluate endpoint(s).
//
// Usage:
//   BLOCKFROST_PROJECT_ID_PREPROD=preprod... \
//     node scripts/probe-blockfrost-evaluator.mjs <tx-cbor-hex>
//
// The hex is the *unsigned* tx body mesh produced — copy from the
// "For txHex: ..." trailer of the failing browser error. The script
// hits Blockfrost's evaluator three different ways and prints the
// raw response from each, so we can tell whether the failure is
// content-type, request shape, or the evaluator stack itself.
//
// What it tries:
//   1. POST /utils/txs/evaluate (no version query) — Blockfrost defaults
//      to ogmios v5, which is pre-Conway and doesn't know `xor_bytearray`
//      (builtin 77). This is mesh's current path; expected to fail with
//      EvaluationFailure: ScriptFailures: {}.
//   2. POST /utils/txs/evaluate?version=6 — modern ogmios. Supports all
//      Conway-era builtins. Response shape is JSON-RPC 2.0 instead of
//      jsonwsp.
//   3. POST /utils/txs/evaluate/utxos?version=6 — same modern stack
//      with the additional_utxos JSON wrapper, in case mesh's plain
//      hex-body variant trips up newer Blockfrost.
//
// Whichever of (2) or (3) returns a real EvaluationResult tells us how
// to wire the SDK. We then patch our chain provider's evaluator
// helper to hit that endpoint with `?version=6`.

const projectId = process.env.BLOCKFROST_PROJECT_ID_PREPROD;
if (!projectId) {
  console.error("set BLOCKFROST_PROJECT_ID_PREPROD");
  process.exit(1);
}
const txHex = process.argv[2];
if (!txHex) {
  console.error("usage: node probe-blockfrost-evaluator.mjs <tx-cbor-hex>");
  process.exit(1);
}

const baseUrl = "https://cardano-preprod.blockfrost.io/api/v0";

async function show(label, res) {
  const body = await res.text();
  console.log(`\n=== ${label} ===`);
  console.log(`status: ${res.status} ${res.statusText}`);
  console.log(`body:   ${body.slice(0, 800)}${body.length > 800 ? "…" : ""}`);
}

// 1) Default (no version query) — ogmios v5, expected to fail.
const r1 = await fetch(`${baseUrl}/utils/txs/evaluate`, {
  method: "POST",
  headers: { "Content-Type": "application/cbor", project_id: projectId },
  body: txHex,
});
await show("1. /utils/txs/evaluate (default = ogmios v5)", r1);

// 2) Same endpoint, ?version=6 — ogmios v6, Conway-aware.
const r2 = await fetch(`${baseUrl}/utils/txs/evaluate?version=6`, {
  method: "POST",
  headers: { "Content-Type": "application/cbor", project_id: projectId },
  body: txHex,
});
await show("2. /utils/txs/evaluate?version=6 (ogmios v6)", r2);

// 3) /utils/txs/evaluate/utxos with version=6 + empty additional_utxos.
const r3 = await fetch(
  `${baseUrl}/utils/txs/evaluate/utxos?version=6`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json", project_id: projectId },
    body: JSON.stringify({ cbor: txHex, additionalUtxoSet: [] }),
  },
);
await show(
  "3. /utils/txs/evaluate/utxos?version=6 (JSON + additionalUtxoSet=[])",
  r3,
);

// 4) Koios's ogmios proxy — JSON-RPC 2.0 evaluateTransaction.
//    https://preprod.koios.rest/#post-/ogmios — public, no API key.
const koiosBody = {
  jsonrpc: "2.0",
  method: "evaluateTransaction",
  params: { transaction: { cbor: txHex } },
};
const r4 = await fetch("https://preprod.koios.rest/api/v1/ogmios", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(koiosBody),
});
await show("4. Koios /ogmios evaluateTransaction (free public endpoint)", r4);
