"""Opt-in launch rehearsal with real tools and read-only Koios evaluation.

LOVEJOIN_KOIOS_REHEARSAL=1 python3 -m unittest discover -s infra/bootstrap \
    -p 'test_koios_rehearsal.py'

All keys, contracts, journals, and signed transactions live in a temporary
copy. Inputs are fictitious. Submission is replaced by an in-memory ledger;
HTTP access is restricted to protocol parameters and evaluateTransaction.
"""

from contextlib import ExitStack
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import urllib.request

SPEC = importlib.util.spec_from_file_location("koios_rehearsal", Path(__file__).with_name("koios-launch.py"))
launch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launch)


class InterruptedRehearsal(BaseException):
    pass


@unittest.skipUnless(os.environ.get("LOVEJOIN_KOIOS_REHEARSAL") == "1", "opt-in real-tool/read-only Koios rehearsal")
class LaunchRehearsal(unittest.TestCase):
    def test_full_launch_and_resume_without_fee_utxos(self):
        import cbor2

        repo = launch.ROOT
        real_urlopen = urllib.request.urlopen
        real_koios = launch.koios
        real_cli = launch.cli
        stages = ("prep", "publish_mix_box", "publish_mix_logic", "publish_fee_contract",
                  "register", "mint", "sweep")
        ledger = {}
        accepted = {}
        seen_stages = []
        evaluations = []
        interrupted = set()
        registered = False
        addresses = {}
        spent_lovelace = 0
        mainnet_params = None

        def read_only_http(request, *args, **kwargs):
            self.assertIsInstance(request, urllib.request.Request)
            self.assertIn(request.full_url, (launch.KOIOS + "/cli_protocol_params", launch.KOIOS + "/ogmios"))
            if request.full_url.endswith("/ogmios"):
                self.assertEqual(json.loads(request.data)["method"], "evaluateTransaction")
            return real_urlopen(request, *args, **kwargs)

        def guarded_cli(*args):
            self.assertNotIn("submit", args)
            return real_cli(*args)

        def remember_address(address):
            raw = bytes.fromhex(json.loads(real_cli("address", "info", "--address", address))["base16"])
            addresses[raw] = address
            return address

        def address_of(raw):
            if raw not in addresses:
                for name in ("reference_holder", "fee_contract", "mix_box", "mix_logic"):
                    remember_address(launch.script_address(name))
            return addresses[raw]

        def datum_json(value):
            if isinstance(value, cbor2.CBORTag) and value.tag == 121:
                return {"constructor": 0, "fields": [datum_json(x) for x in value.value]}
            if isinstance(value, bytes):
                return {"bytes": value.hex()}
            if isinstance(value, int):
                return {"int": value}
            raise AssertionError(f"Unexpected datum shape: {value}")

        def decode_output(txid, index, output):
            value = output[1]
            coin, assets = (value, {}) if isinstance(value, int) else value
            row = {"tx_hash": txid, "tx_index": index, "address": address_of(output[0]),
                   "value": str(coin), "asset_list": [], "reference_script": None,
                   "inline_datum": None, "is_spent": False}
            for policy, tokens in assets.items():
                row["asset_list"].extend({"policy_id": policy.hex(), "asset_name": name.hex(),
                                           "quantity": str(quantity)} for name, quantity in tokens.items())
            if 2 in output:
                self.assertEqual(output[2][0], 1)
                datum = output[2][1].value
                row["inline_datum"] = {"bytes": datum.hex(), "value": datum_json(cbor2.loads(datum))}
            if 3 in output:
                language, script = cbor2.loads(output[3].value)
                self.assertEqual(language, 3)
                row["reference_script"] = {"hash": hashlib.blake2b(b"\x03" + script, digest_size=28).hexdigest(),
                                           "size": len(script), "type": "plutusV3", "bytes": script.hex()}
            return row

        def additional(row):
            value = {"ada": {"lovelace": int(row["value"])}}
            for asset in row["asset_list"]:
                value.setdefault(asset["policy_id"], {})[asset["asset_name"]] = int(asset["quantity"])
            result = {"transaction": {"id": row["tx_hash"]}, "index": row["tx_index"],
                      "address": row["address"], "value": value}
            if row["inline_datum"]:
                result["datum"] = row["inline_datum"]["bytes"]
            if row["reference_script"]:
                # Preserve the ledger's tagged reference-script encoding. The
                # Ogmios JSON script decoder checks the language's initial
                # protocol version, which can reject newer compiler builtins.
                script = bytes.fromhex(row["reference_script"]["bytes"])
                result["script"] = cbor2.dumps(cbor2.CBORTag(24, cbor2.dumps([3, script]))).hex()
            return result

        def refs(body, key):
            return [f"{txid.hex()}#{index}" for txid, index in body.get(key, [])]

        def request(path, body=None):
            nonlocal mainnet_params
            if path == "/cli_protocol_params":
                if mainnet_params is None:
                    mainnet_params = real_koios(path)
                return mainnet_params
            if path == "/address_utxos":
                return [row for row in ledger.values() if row["address"] in body["_addresses"] and not row["is_spent"]]
            if path == "/utxo_info":
                return [ledger[ref] for ref in body["_utxo_refs"] if ref in ledger]
            if path == "/tx_status":
                return [{"tx_hash": txid, "num_confirmations": 2} for txid in body["_tx_hashes"] if txid in accepted]
            if path == "/account_info":
                return [{"stake_address": a, "status": "registered" if registered else "not registered"}
                        for a in body["_stake_addresses"]]
            self.assertEqual(path, "/ogmios")
            self.assertEqual(body["method"], "evaluateTransaction")
            txbody = cbor2.loads(bytes.fromhex(body["params"]["transaction"]["cbor"]))[0]
            inputs = [ref for k in (0, 13, 18) for ref in refs(txbody, k)]
            self.assertTrue(all(not ledger[ref]["is_spent"] for ref in inputs))
            # Fictitious inputs allow real script execution without funding or submission.
            body["params"]["additionalUtxo"] = [additional(ledger[ref]) for ref in inputs]
            result = real_koios(path, body)
            evaluations.append(result)
            return result

        def accept_locally(signed, txid):
            nonlocal registered, spent_lovelace
            name = signed.stem
            self.assertIn(name, stages)
            self.assertNotIn(txid, accepted, "A confirmed stage must never be submitted again")
            tx = cbor2.loads(bytes.fromhex(launch.read_json(signed)["cborHex"]))
            body = tx[0]
            self.assertIs(tx[2], True)
            self.assertEqual(len(tx[1][0]), 1, "Exactly one wallet witness")
            inputs = refs(body, 0)
            self.assertTrue(all(not ledger[ref]["is_spent"] for ref in inputs))
            self.assertTrue(all(not ledger[ref]["is_spent"] for ref in refs(body, 13) + refs(body, 18)))
            outputs = [decode_output(txid, i, out) for i, out in enumerate(body[1])]
            deposit = mainnet_params["stakeAddressDeposit"] if name == "register" else 0
            self.assertEqual(sum(int(ledger[ref]["value"]) for ref in inputs),
                             sum(int(out["value"]) for out in outputs) + body[2] + deposit)
            self.assertLessEqual(len(bytes.fromhex(launch.read_json(signed)["cborHex"])), mainnet_params["maxTxSize"])
            if name in ("register", "mint"):
                self.assertGreaterEqual(body[17] * 100, body[2] * mainnet_params["collateralPercentage"])
                self.assertEqual(body[17] + body[16][1], 10_000_000)
                receipt = launch.read_json(launch.WALLET / f"{name}.evaluation.json")
                self.assertEqual(receipt["txid"], txid)
            if name == "register":
                self.assertEqual(list(body[4])[0][0], 7, "Conway stake registration certificate")
                registered = True
            for ref in inputs:
                ledger[ref]["is_spent"] = True
            ledger.update({launch.ref_of(row): row for row in outputs})
            accepted[txid] = body
            seen_stages.append(name)
            spent_lovelace += body[2]
            print(f"  REHEARSAL {name}: fee {body[2]} lovelace, {len(outputs)} outputs")
            # Simulate process loss AFTER acceptance but BEFORE the address book
            # records the stage. Repeat at every stage, including the final sweep.
            if name not in interrupted:
                interrupted.add(name)
                raise InterruptedRehearsal(name)

        with tempfile.TemporaryDirectory(prefix="lovejoin-launch-rehearsal-") as directory, ExitStack() as stack:
            root = Path(directory)
            bootstrap = root / "infra" / "bootstrap"
            bootstrap.mkdir(parents=True)
            shutil.copy2(repo / "infra/bootstrap/00-build-reference.sh", bootstrap)
            shutil.copytree(repo / "infra/bootstrap/_lib", bootstrap / "_lib")
            shutil.copytree(repo / "contracts", root / "contracts", ignore=shutil.ignore_patterns("build", ".build", "plutus*.json"))
            # Reuse already downloaded dependencies without changing the working copy.
            if (repo / "contracts/build/packages").exists():
                shutil.copytree(repo / "contracts/build/packages", root / "contracts/build/packages")
            (root / "config").mkdir()
            shutil.copy2(repo / "config/network.mainnet.json", root / "config/network.mainnet.json")
            (root / "artifacts/preprod").mkdir(parents=True)
            shutil.copy2(repo / "artifacts/preprod/addresses.json", root / "artifacts/preprod/addresses.json")
            wallet = bootstrap / "wallets" / "rehearsal-only"
            wallet.mkdir(parents=True, mode=0o700)
            artifacts = root / "artifacts/mainnet"
            replacements = {"ROOT": root, "BOOTSTRAP": bootstrap, "WALLET": wallet,
                            "ARTIFACTS": artifacts, "BOOK": artifacts / "addresses.json",
                            "STATE": wallet / "launch-state.json", "CONFIG": root / "config/network.mainnet.json",
                            "cli": guarded_cli, "koios": request, "submit": accept_locally}
            for key, value in replacements.items():
                stack.enter_context(patch.object(launch, key, value))
            stack.enter_context(patch.object(urllib.request, "urlopen", read_only_http))
            stack.enter_context(patch.dict(os.environ, {"LOVEJOIN_MAINNET_CONFIRM": "yes"}))
            for label in ("payment", "refund"):
                real_cli("address", "key-gen", "--verification-key-file", str(wallet / f"{label}.vkey"),
                         "--signing-key-file", str(wallet / f"{label}.skey"))
            address = remember_address(real_cli("address", "build", "--payment-verification-key-file", str(wallet / "payment.vkey"), "--mainnet"))
            destination = remember_address(real_cli("address", "build", "--payment-verification-key-file", str(wallet / "refund.vkey"), "--mainnet"))
            (wallet / "payment.addr").write_text(address)
            ledger["f" * 64 + "#0"] = {"tx_hash": "f" * 64, "tx_index": 0, "address": address,
                                         "value": "105000000", "asset_list": [], "is_spent": False,
                                         "reference_script": None, "inline_datum": None}
            for _ in range(len(stages) + 1):
                try:
                    launch.launch(destination, True)
                    break
                except InterruptedRehearsal as exc:
                    print(f"  REHEARSAL resume after accepted {exc}")
            else:
                self.fail("Rehearsal never reached completion")
            self.assertEqual(seen_stages, list(stages))
            book = launch.read_json(launch.BOOK)
            self.assertEqual(book["feeShardUtxos"], [])
            self.assertEqual(book["protocol"]["fee_shard_target"], 0)
            self.assertNotIn("shards", book["deploymentTxs"])
            fee_address = launch.script_address("fee_contract")
            self.assertFalse(any(row["address"] == fee_address for row in ledger.values()))
            self.assertEqual(book["refund"]["address"], destination)
            self.assertEqual(book["refund"]["lovelace"], 105_000_000 - 82_000_000 - spent_lovelace)
            self.assertEqual(len([row for row in ledger.values() if not row["is_spent"] and row["address"] == address]), 3)
            self.assertGreaterEqual(len(evaluations), 6)
            self.assertTrue(all("result" in result for result in evaluations))
            print(f"REHEARSAL PASSED: {len(stages)} stages, {len(evaluations)} Koios evaluations, "
                  f"fees {spent_lovelace / 1_000_000:.6f} ADA, refund {book['refund']['lovelace'] / 1_000_000:.6f} ADA")


if __name__ == "__main__":
    unittest.main()
