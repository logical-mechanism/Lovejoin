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

    def test_resume_rejects_old_fee_funding_journal(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "launch-state.json"
            state_path.write_text('{"network":"mainnet","mode":"full",'
                                  '"returnAddress":"addr1return","stages":{}}')
            with patch.object(launch, "STATE", state_path), \
                 patch.object(launch, "WALLET", Path(directory)), \
                 patch.object(launch, "wallet_address", return_value="addr1launch"), \
                 patch.object(launch, "validate_mainnet_address"), \
                 patch.dict("os.environ", {"LOVEJOIN_MAINNET_CONFIRM": "yes"}):
                with self.assertRaisesRegex(launch.LaunchError, "without fee UTxOs"):
                    launch.launch("addr1return", True)

    def test_spent_utxo_is_not_accepted_as_spendable(self):
        row = {"tx_hash": "a" * 64, "tx_index": 0, "is_spent": True}
        with patch.object(launch, "koios", return_value=[row]):
            with self.assertRaisesRegex(launch.LaunchError, "is spent"):
                launch.utxo("a" * 64 + "#0")
            self.assertEqual(launch.utxo("a" * 64 + "#0", require_unspent=False), row)

    def test_evaluator_retries_json_rpc_unknown_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            signed = Path(directory) / "tx.signed"
            signed.write_text('{"cborHex":"80"}')
            responses = [{"error": {"code": 3010, "message": "Unknown transaction inputs"}},
                         {"result": [{"validator": {"purpose": "mint", "index": 0},
                                      "budget": {"cpu": 10000, "memory": 1000}}]}]
            with patch.object(launch, "koios", side_effect=responses) as request, \
                 patch.object(launch.time, "sleep"):
                self.assertEqual(launch.evaluate_tx(signed, "mint:0"), (10000, 1000))
                self.assertEqual(request.call_count, 2)
            with patch.object(launch, "koios", return_value={"error": {"message": "Script failed"}}) as request:
                with self.assertRaises(launch.LaunchError):
                    launch.evaluate_tx(signed, "mint:0")
                self.assertEqual(request.call_count, 1)

    def test_included_transaction_is_not_resubmitted(self):
        with patch.object(launch, "prepare_stage", return_value="a" * 64), \
             patch.object(launch, "status", return_value=1), \
             patch.object(launch, "submit") as submit, \
             patch.object(launch, "await_confirmed") as confirm:
            self.assertEqual(launch.run_stage({"stages": {}}, "prep", None), "a" * 64)
            submit.assert_not_called()
            confirm.assert_called_once_with("a" * 64)

    def test_changed_signed_file_is_rejected_on_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            wallet = Path(directory)
            signed = wallet / "prep.tx"
            signed.write_text('{"cborHex":"80"}')
            state = {"stages": {}}
            with patch.object(launch, "STATE", wallet / "state.json"), \
                 patch.object(launch, "cli", return_value="a" * 64):
                launch.prepare_stage(state, "prep", lambda: (signed, "a" * 64))
                signed.write_text('{"cborHex":"81"}')
                with self.assertRaisesRegex(launch.LaunchError, "differs from resume journal"):
                    launch.prepare_stage(state, "prep", None)

    def test_compile_failure_happens_before_any_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            wallet = Path(directory)
            signed = wallet / "prep.tx"
            signed.write_text('{"cborHex":"80"}')
            with patch.object(launch, "WALLET", wallet), \
                 patch.object(launch, "STATE", wallet / "state.json"), \
                 patch.object(launch, "BOOK", wallet / "addresses.json"), \
                 patch.object(launch, "protocol_params", return_value={}), \
                 patch.object(launch, "address_utxos", return_value=[{"value": "105000000"}]), \
                 patch.object(launch, "build_tx", return_value=(signed, "a" * 64)), \
                 patch.object(launch, "cli", return_value="a" * 64), \
                 patch.object(launch, "prepare_book", side_effect=launch.LaunchError("Compile failed")), \
                 patch.object(launch, "submit") as submit:
                with self.assertRaisesRegex(launch.LaunchError, "Compile failed"):
                    launch.launch_locked("addr1return", "addr1launch")
                submit.assert_not_called()

    def test_second_launch_cannot_acquire_wallet_lock(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(launch, "WALLET", Path(directory)):
            with launch.launch_lock():
                with self.assertRaisesRegex(launch.LaunchError, "Another mainnet launch"):
                    with launch.launch_lock():
                        self.fail("Second process must not acquire the lock")

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
