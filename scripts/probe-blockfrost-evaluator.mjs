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
//   1. POST /utils/txs/evaluate, body = hex string,  Content-Type: application/cbor
//      (this is what mesh's evaluator does today)
//   2. POST /utils/txs/evaluate, body = raw bytes,  Content-Type: application/cbor
//      (matches what mesh's submitTx does — we know that's what /tx/submit wants)
//   3. POST /utils/txs/evaluate/utxos, body = JSON { cbor, additional_utxos: [] }
//      (Blockfrost's "evaluate with additional UTxOs" variant)
//
// If all three return the same EvaluationFailure: ScriptFailures: {},
// it's not a request-shape issue — Blockfrost can't evaluate this tx
// regardless of how we feed it. If one works, that's the path to
// switch to.

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

// 1) hex string with application/cbor — mesh's current behaviour
const r1 = await fetch(`${baseUrl}/utils/txs/evaluate`, {
  method: "POST",
  headers: { "Content-Type": "application/cbor", project_id: projectId },
  body: txHex,
});
await show("1. hex-string + application/cbor (mesh's path)", r1);

// 2) raw bytes with application/cbor — same shape as /tx/submit
const bytes = new Uint8Array(txHex.length / 2);
for (let i = 0; i < bytes.length; i++) {
  bytes[i] = Number.parseInt(txHex.slice(i * 2, i * 2 + 2), 16);
}
const r2 = await fetch(`${baseUrl}/utils/txs/evaluate`, {
  method: "POST",
  headers: { "Content-Type": "application/cbor", project_id: projectId },
  body: bytes,
});
await show("2. raw-bytes + application/cbor", r2);

// 3) /utils/txs/evaluate/utxos with additional_utxos = []
const r3 = await fetch(`${baseUrl}/utils/txs/evaluate/utxos`, {
  method: "POST",
  headers: { "Content-Type": "application/json", project_id: projectId },
  body: JSON.stringify({ cbor: txHex, additional_utxos: [] }),
});
await show("3. /utils/txs/evaluate/utxos (JSON + additional_utxos=[])", r3);
