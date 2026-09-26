"""Offline safety checks for the one-time Koios launcher."""

import importlib.util
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("koios-launch.py")
SPEC = importlib.util.spec_from_file_location("koios_launch", MODULE_PATH)
launch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launch)


class LaunchSafetyTests(unittest.TestCase):
    def test_mainnet_submission_requires_both_guards(self):
        with patch.object(launch, "validate_mainnet_address") as validate:
            with patch.dict("os.environ", {}, clear=True):
                with self.assertRaises(launch.LaunchError):
                    launch.launch("addr1placeholder", False)
                with self.assertRaises(launch.LaunchError):
                    launch.launch("addr1placeholder", True)
            with patch.dict("os.environ", {"LOVEJOIN_MAINNET_CONFIRM": "yes"}):
                with self.assertRaises(launch.LaunchError):
                    launch.launch("addr1placeholder", False)
            validate.assert_not_called()

    def test_resume_rejects_changed_funding_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "launch-state.json"
            state_path.write_text('{"network":"mainnet","mode":"full",'
                                  '"returnAddress":"addr1return","stages":{}}')
            with patch.object(launch, "STATE", state_path), \
                 patch.object(launch, "wallet_address", return_value="addr1launch"), \
                 patch.object(launch, "validate_mainnet_address"), \
                 patch.dict("os.environ", {"LOVEJOIN_MAINNET_CONFIRM": "yes"}):
                with self.assertRaisesRegex(launch.LaunchError, "mode differs"):
                    launch.launch("addr1return", True, "core")

    def test_evaluator_result_requires_expected_redeemer(self):
        with tempfile.TemporaryDirectory() as directory:
            signed = Path(directory) / "tx.signed"
            signed.write_text('{"cborHex":"80"}')
            with patch.object(launch, "koios", return_value={
                "jsonrpc": "2.0", "result": [{"validator": {"purpose": "mint", "index": 0},
                                                "budget": {"cpu": 10000, "memory": 1000}}]
            }) as request:
                self.assertEqual(launch.evaluate_tx(signed, "mint:0"), (10000, 1000))
                self.assertEqual(request.call_args.args[0], "/ogmios")
                self.assertEqual(request.call_args.args[1]["method"], "evaluateTransaction")
            with patch.object(launch, "koios", return_value={
                "result": [{"validator": {"purpose": "publish", "index": 0},
                            "budget": {"cpu": 4217188, "memory": 15515}}]
            }):
                self.assertEqual(launch.evaluate_tx(signed, "certificate:0"), (4217188, 15515))
            with patch.object(launch, "koios", return_value={
                "result": [{"validator": "certificate:0",
                            "budget": {"cpu": 10000, "memory": 1000}}]
            }):
                with self.assertRaises(launch.LaunchError):
                    launch.evaluate_tx(signed, "mint:0")

    def test_evaluated_builder_rechecks_final_transaction(self):
        with tempfile.TemporaryDirectory() as directory:
            wallet = Path(directory)
            budgets = []
            def extra(budget):
                budgets.append(budget)
                return [budget]
            with patch.object(launch, "WALLET", wallet), \
                 patch.object(launch, "build_tx", side_effect=[(wallet / "draft", "a" * 64),
                                                               (wallet / "final", "b" * 64)]), \
                 patch.object(launch, "evaluate_tx", side_effect=[(10000, 1000), (11000, 1100)]) as evaluate:
                result = launch.build_evaluated_tx("mint", "mint:0", [], [], "addr1",
                                                   extra, {"maxTxExecutionUnits":
                                                           {"steps": 10000000000, "memory": 16500000}})
            self.assertEqual(result[1], "b" * 64)
            self.assertEqual(budgets, ["(0,0)", "(1010000,6000)"])
            self.assertEqual(evaluate.call_count, 2)
            receipt = launch.read_json(wallet / "mint.evaluation.json")
            self.assertEqual(receipt["used"], {"steps": 11000, "memory": 1100})

    def test_refund_address_requires_mainnet_key_payment(self):
        with patch.object(launch, "cli", return_value='{"type":"payment","encoding":"bech32","base16":"6100"}'):
            launch.validate_mainnet_address("addr1valid")
        with patch.object(launch, "cli", return_value='{"type":"payment","encoding":"bech32","base16":"7100"}'):
            with self.assertRaises(launch.LaunchError):
                launch.validate_mainnet_address("addr1script")
        with patch.object(launch, "cli", return_value='{"type":"payment","encoding":"bech32","base16":"6000"}'):
            with self.assertRaises(launch.LaunchError):
                launch.validate_mainnet_address("addr_test1wrongnetwork")

    def test_final_sweep_preserves_reference_scripts_and_rejects_assets(self):
        ref = {"tx_hash": "a" * 64, "tx_index": 0, "value": "25000000",
               "asset_list": [], "reference_script": {"hash": "b" * 56}}
        change = {"tx_hash": "c" * 64, "tx_index": 1, "value": "3000000",
                  "asset_list": [], "reference_script": None}
        self.assertEqual(launch.select_sweep_inputs([ref, change], {launch.ref_of(ref)}), [change])
        with self.assertRaises(launch.LaunchError):
            launch.select_sweep_inputs([ref, change], set())
        asset_change = dict(change, asset_list=[{"policy_id": "d" * 56, "quantity": "1"}])
        with self.assertRaises(launch.LaunchError):
            launch.select_sweep_inputs([ref, asset_change], {launch.ref_of(ref)})


if __name__ == "__main__":
    unittest.main()
