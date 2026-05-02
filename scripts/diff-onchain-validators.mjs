// Compare locally-compiled validator artifacts against what's actually
// pinned on chain at the reference-script UTxOs.
//
// If they differ, the live deployment is running older bytecode than
// your `aiken simulate` — which explains a "local sim passes, chain
// rejects" mismatch perfectly. Re-bootstrapping is the fix; this
// script just confirms the cause.
//
// Usage:
//   make diff-validators                # uses the default network (preprod)
//   NETWORK=preprod node --env-file-if-exists=.env \
//     scripts/diff-onchain-validators.mjs

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const network = process.env.NETWORK ?? "preprod";
const projectId = process.env.BLOCKFROST_PROJECT_ID_PREPROD;
if (!projectId) {
  console.error("set BLOCKFROST_PROJECT_ID_PREPROD");
  process.exit(1);
}
const baseUrl =
  network === "mainnet"
    ? "https://cardano-mainnet.blockfrost.io/api/v0"
    : network === "preview"
      ? "https://cardano-preview.blockfrost.io/api/v0"
      : "https://cardano-preprod.blockfrost.io/api/v0";

const root = resolve(import.meta.dirname, "..");
const addressesPath = resolve(root, `artifacts/${network}/addresses.json`);
const addresses = JSON.parse(readFileSync(addressesPath, "utf8"));

// Map each script's name → on-chain ref + local artifact path. The
// on-chain ref points to the UTxO that holds the CIP-33 reference
// script; we fetch that script's bytes from Blockfrost and diff.
const targets = [
  {
    name: "mix_logic",
    onChainRef: addresses.referenceScriptUtxos?.mix_logic,
    expectedHash: addresses.mixLogicScriptHash,
    localCbor: resolve(root, `artifacts/${network}/mix_logic.cbor.hex`),
    localPlutus: resolve(root, `artifacts/${network}/mix_logic.plutus`),
  },
  {
    name: "mix_box",
    onChainRef: addresses.referenceScriptUtxos?.mix_box,
    expectedHash: addresses.mixBoxScriptHash,
    localCbor: resolve(root, `artifacts/${network}/mix_box.cbor.hex`),
    localPlutus: resolve(root, `artifacts/${network}/mix_box.plutus`),
  },
  {
    name: "fee_contract",
    onChainRef: addresses.referenceScriptUtxos?.fee_contract,
    expectedHash: addresses.feeScriptHash,
    localCbor: resolve(root, `artifacts/${network}/fee_contract.cbor.hex`),
    localPlutus: resolve(root, `artifacts/${network}/fee_contract.plutus`),
  },
];

async function bf(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { project_id: projectId },
  });
  if (!res.ok) {
    throw new Error(`Blockfrost GET ${path}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function readLocalScriptHex(target) {
  // The Aiken bootstrap output writes the bytes-encoded validator to
  // `<name>.plutus` as a Plutus envelope JSON ({type, description,
  // cborHex}). Read that and pull `cborHex`.
  try {
    const env = JSON.parse(readFileSync(target.localPlutus, "utf8"));
    if (typeof env.cborHex === "string") return env.cborHex.toLowerCase();
  } catch {
    /* fall through */
  }
  // Fallback: a `<name>.cbor.hex` flat file if present.
  try {
    return readFileSync(target.localCbor, "utf8").trim().toLowerCase();
  } catch {
    return null;
  }
}

for (const t of targets) {
  console.log(`\n=== ${t.name} ===`);
  console.log(`  on-chain ref:    ${t.onChainRef}`);
  console.log(`  expected hash:   ${t.expectedHash}`);
  if (!t.onChainRef) {
    console.log("  (skipping — no on-chain ref recorded in addresses.json)");
    continue;
  }
  const [txId, idxStr] = t.onChainRef.split("#");
  const idx = Number(idxStr);

  // Find the UTxO + its reference_script field.
  const out = await bf(`/txs/${txId}/utxos`);
  const utxo = (out.outputs ?? []).find((o) => o.output_index === idx);
  if (!utxo) {
    console.log(`  (skipping — UTxO ${t.onChainRef} not found on chain)`);
    continue;
  }
  const onChainHash = utxo.reference_script_hash ?? utxo.reference_script ?? null;
  if (!onChainHash) {
    console.log(`  (skipping — UTxO has no attached reference script)`);
    continue;
  }
  console.log(`  on-chain hash:   ${onChainHash}`);

  // Fetch the actual script bytes pinned at that hash.
  let onChainCbor;
  try {
    const script = await bf(`/scripts/${onChainHash}/cbor`);
    onChainCbor = (script.cbor ?? "").toLowerCase();
  } catch (e) {
    console.log(`  (skipping — cannot fetch script cbor: ${e.message})`);
    continue;
  }

  const localCbor = readLocalScriptHex(t);
  if (!localCbor) {
    console.log("  (no local artifact found — run `make contracts`)");
    continue;
  }

  if (onChainCbor === localCbor) {
    console.log(`  ✓ on-chain bytes MATCH local artifact (${onChainCbor.length / 2} B)`);
  } else {
    console.log(`  ✗ MISMATCH — re-bootstrap needed`);
    console.log(`    on-chain bytes: ${onChainCbor.length / 2} B`);
    console.log(`    local bytes:    ${localCbor.length / 2} B`);
    // First-difference offset, for quick eyeballing
    const minLen = Math.min(onChainCbor.length, localCbor.length);
    let diffAt = -1;
    for (let i = 0; i < minLen; i++) {
      if (onChainCbor[i] !== localCbor[i]) {
        diffAt = i;
        break;
      }
    }
    if (diffAt >= 0) {
      const ctx = (s) => s.slice(Math.max(0, diffAt - 8), diffAt + 16);
      console.log(`    first byte diff at hex offset ${diffAt / 2}:`);
      console.log(`      on-chain: …${ctx(onChainCbor)}…`);
      console.log(`      local:    …${ctx(localCbor)}…`);
    }
  }
}
