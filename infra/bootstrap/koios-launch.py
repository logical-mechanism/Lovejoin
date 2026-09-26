#!/usr/bin/env python3
"""One-time Cardano mainnet bootstrap with offline cardano-cli and public Koios.

No transaction is submitted except by the explicit `launch` subcommand. The
private wallet, signed transactions, and resume journal stay gitignored.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = Path(__file__).resolve().parent
WALLET = BOOTSTRAP / "wallets" / "mainnet-launch"
ARTIFACTS = ROOT / "artifacts" / "mainnet"
BOOK = ARTIFACTS / "addresses.json"
STATE = WALLET / "launch-state.json"
CONFIG = ROOT / "config" / "network.mainnet.json"
KOIOS = "https://api.koios.rest/api/v1"
ASSET_NAME = "6c6f76656a6f696e"
CORE_SPLIT = (85_000_000, 10_000_000, 7_000_000)
FULL_SPLIT = CORE_SPLIT + (55_000_000,)
PUBLISH_LOVELACE = 25_000_000
LOCKED_LOVELACE = 5_000_000
SHARD_LOVELACE = 5_000_000
SHARD_COUNT = 10
MIN_LAUNCH_LOVELACE = {"core": 105_000_000, "full": 160_000_000}
CONFIRM_TIMEOUT = 900


class LaunchError(RuntimeError):
    pass


def cli(*args: str) -> str:
    result = subprocess.run(["cardano-cli", "conway", *map(str, args)], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise LaunchError(f"cardano-cli {' '.join(map(str, args[:3]))}: {result.stderr.strip()}")
    return result.stdout.strip()


def atomic_json(path: Path, value: dict, private: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".new")
    with open(tmp, "w", encoding="utf-8") as out:
        json.dump(value, out, indent=2)
        out.write("\n")
    os.chmod(tmp, 0o600 if private else 0o644)
    tmp.replace(path)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def koios(path: str, body: dict | None = None) -> list | dict:
    url = KOIOS + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, data=data, headers=headers,
                                             method="POST" if data is not None else "GET")
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read(2000).decode(errors="replace")
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise LaunchError(f"Koios {path}: HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 2:
                raise LaunchError(f"Koios {path}: {exc}") from exc
        time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def submit(tx_file: Path, expected_txid: str) -> None:
    payload = bytes.fromhex(read_json(tx_file)["cborHex"])
    request = urllib.request.Request(KOIOS + "/submittx", data=payload,
                                     headers={"Accept": "application/json",
                                              "Content-Type": "application/cbor"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            answer = response.read().decode().strip().strip('"')
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
        # A timeout can mean accepted-but-no-response. The saved signed tx and
        # txid make retry safe; the caller checks confirmation before rebuilding.
        raise LaunchError(f"Koios submit {expected_txid}: {exc}") from exc
    if expected_txid not in answer:
        raise LaunchError(f"Koios returned unexpected txid for {expected_txid}: {answer[:200]}")
    print(f"  submitted {expected_txid}", flush=True)


def status(txid: str) -> int:
    rows = koios("/tx_status", {"_tx_hashes": [txid]})
    for row in rows:
        if row.get("tx_hash") == txid:
            return int(row.get("num_confirmations") or 0)
    return 0


def await_confirmed(txid: str) -> None:
    deadline = time.monotonic() + CONFIRM_TIMEOUT
    while time.monotonic() < deadline:
        if status(txid) >= 2:
            print(f"  confirmed {txid}", flush=True)
            return
        time.sleep(10)
    raise LaunchError(f"{txid} has not reached two confirmations; rerun launch to resume")


def address_utxos(address: str) -> list[dict]:
    rows = koios("/address_utxos", {"_addresses": [address], "_extended": True})
    if not isinstance(rows, list):
        raise LaunchError("Koios address_utxos returned an unexpected response")
    if len(rows) >= 1000:
        raise LaunchError("Wallet has at least 1000 UTxOs; pagination is required")
    return rows


def utxo(ref: str, wait: bool = False) -> dict:
    deadline = time.monotonic() + (120 if wait else 0)
    while True:
        rows = koios("/utxo_info", {"_utxo_refs": [ref], "_extended": True})
        for row in rows:
            if f"{row.get('tx_hash')}#{row.get('tx_index')}" == ref:
                return row
        if time.monotonic() >= deadline:
            raise LaunchError(f"Expected unspent UTxO missing from Koios: {ref}")
        time.sleep(5)


def validate_mainnet_address(address: str) -> None:
    info = json.loads(cli("address", "info", "--address", address))
    header = info.get("base16", "")[:2].lower()
    if not (address.startswith("addr1") and info.get("type") == "payment"
            and info.get("encoding") == "bech32" and len(header) == 2
            and header[0] in "0246" and header[1] == "1"):
        raise LaunchError("Address must be a key-controlled Cardano mainnet payment address (addr1...)")


def wallet_address() -> str:
    addr_file = WALLET / "payment.addr"
    if not (WALLET / "payment.skey").is_file() or not (WALLET / "payment.vkey").is_file() or not addr_file.is_file():
        raise LaunchError("Launch wallet missing; run `koios-launch.py wallet` locally first")
    address = addr_file.read_text().strip()
    derived = cli("address", "build", "--payment-verification-key-file",
                  str(WALLET / "payment.vkey"), "--mainnet")
    if address != derived:
        raise LaunchError("Stored launch address does not match launch verification key")
    validate_mainnet_address(address)
    return address


def make_wallet() -> None:
    if WALLET.exists() and any(WALLET.iterdir()):
        print(f"Launch wallet already exists: {wallet_address()}")
        return
    WALLET.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(WALLET, 0o700)
    cli("address", "key-gen", "--verification-key-file", str(WALLET / "payment.vkey"),
        "--signing-key-file", str(WALLET / "payment.skey"))
    os.chmod(WALLET / "payment.skey", 0o600)
    address = cli("address", "build", "--payment-verification-key-file",
                  str(WALLET / "payment.vkey"), "--mainnet")
    (WALLET / "payment.addr").write_text(address + "\n")
    print(f"One-time mainnet launch address: {address}")
    print("Keep payment.skey private. Funding this address does not start the launch.")


def show_status() -> None:
    address = wallet_address()
    rows = address_utxos(address)
    total = sum(int(row["value"]) for row in rows)
    print(f"Launch address: {address}\nUTxOs: {len(rows)}\nADA: {total / 1_000_000:.6f}")
    if STATE.exists():
        state = read_json(STATE)
        print("Recorded stages:", ", ".join(state.get("stages", {})) or "none")


def protocol_params() -> dict:
    # Koios serves the node's native cardano-cli schema directly. This avoids
    # maintaining a translation from epoch_params across hard forks.
    p = koios("/cli_protocol_params")
    if not isinstance(p, dict):
        raise LaunchError("Koios cli_protocol_params returned an unexpected response")
    required = ("costModels", "executionUnitPrices", "maxTxExecutionUnits",
                "stakeAddressDeposit", "txFeeFixed", "txFeePerByte",
                "utxoCostPerByte", "minFeeRefScriptCostPerByte")
    if any(p.get(field) is None for field in required):
        raise LaunchError("Koios cli_protocol_params lacks a required field")
    if not isinstance(p["costModels"].get("PlutusV3"), list):
        raise LaunchError("Koios returned an unexpected Plutus V3 cost model")
    atomic_json(WALLET / "protocol.json", p, private=True)
    return p


def evaluate_tx(signed: Path, expected_validator: str) -> tuple[int, int]:
    cbor = read_json(signed)["cborHex"]
    request = {"jsonrpc": "2.0", "method": "evaluateTransaction",
               "params": {"transaction": {"cbor": cbor}}}
    for attempt in range(6):
        try:
            response = koios("/ogmios", request)
            break
        except LaunchError as exc:
            # Koios's indexer and Ogmios instances can see a new UTxO at
            # slightly different times after confirmation.
            if "Unknown transaction input" not in str(exc) or attempt == 5:
                raise
            time.sleep(10)
    if not isinstance(response, dict) or response.get("error"):
        raise LaunchError(f"Koios Ogmios evaluation failed: {response}")
    result = response.get("result")
    if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
        raise LaunchError(f"Koios Ogmios returned unexpected redeemers: {result}")
    pointer = result[0].get("validator")
    if isinstance(pointer, dict):
        # Ogmios v7 uses structured pointers; stake registration is "publish".
        purpose = "certificate" if pointer.get("purpose") == "publish" else pointer.get("purpose")
        pointer = f"{purpose}:{pointer.get('index')}"
    if pointer != expected_validator:
        raise LaunchError(f"Koios Ogmios returned unexpected redeemer: {pointer}")
    budget = result[0].get("budget")
    if not isinstance(budget, dict) or not isinstance(budget.get("cpu"), int) or not isinstance(budget.get("memory"), int):
        raise LaunchError(f"Koios Ogmios returned an invalid execution budget: {budget}")
    cpu, memory = budget["cpu"], budget["memory"]
    if cpu <= 0 or memory <= 0:
        raise LaunchError(f"Koios Ogmios returned a non-positive execution budget: {budget}")
    print(f"  Koios evaluation {expected_validator}: {cpu} steps, {memory} memory", flush=True)
    return cpu, memory


def build_evaluated_tx(name: str, expected_validator: str, inputs: list[dict],
                       fixed: list[tuple[str, int, tuple[str, str] | None, str]],
                       change_address: str, extra_for_budget, params: dict,
                       deposit: int = 0, ref_script_size: int = 0) -> tuple[Path, str]:
    # Ogmios expects zero budgets in the draft. Evaluation does not submit it.
    # Rebuild with measured units plus headroom, then evaluate that exact final
    # shape; the changed fee/change output can slightly alter script cost.
    assigned_cpu = assigned_memory = 0
    for _ in range(4):
        signed, txid = build_tx(name, inputs, fixed, change_address,
                                extra_for_budget(f"({assigned_cpu},{assigned_memory})"),
                                deposit, ref_script_size)
        used_cpu, used_memory = evaluate_tx(signed, expected_validator)
        if assigned_cpu >= used_cpu and assigned_memory >= used_memory:
            atomic_json(WALLET / f"{name}.evaluation.json", {
                "validator": expected_validator,
                "used": {"steps": used_cpu, "memory": used_memory},
                "assigned": {"steps": assigned_cpu, "memory": assigned_memory},
            }, private=True)
            return signed, txid
        assigned_cpu = max(used_cpu + 1_000_000, (used_cpu * 125 + 99) // 100)
        assigned_memory = max(used_memory + 5_000, (used_memory * 125 + 99) // 100)
        limits = params["maxTxExecutionUnits"]
        if assigned_cpu > int(limits["steps"]) or assigned_memory > int(limits["memory"]):
            raise LaunchError(f"{name}: evaluated script budget exceeds current network limit")
    raise LaunchError(f"{name}: evaluated script budget did not stabilize")


def amount(row: dict) -> int:
    if row.get("asset_list"):
        raise LaunchError("Launch wallet contains native assets; refusing to spend or sweep them")
    return int(row["value"])


def ref_of(row: dict) -> str:
    return f"{row['tx_hash']}#{row['tx_index']}"


def check_min_utxo(address: str, lovelace: int, option: tuple[str, str] | None = None,
                   asset: str = "") -> None:
    value = f"{address} + {lovelace} lovelace" + (f" + 1 {asset}" if asset else "")
    args = ["transaction", "calculate-min-required-utxo", "--protocol-params-file",
            str(WALLET / "protocol.json"), "--tx-out", value]
    if option:
        args.extend(option)
    response = cli(*args)
    match = re.search(r"\d+", response)
    if not match or lovelace < int(match.group()):
        raise LaunchError(f"Output at {address} requires at least {response} lovelace; planned {lovelace}")


def output_args(address: str, lovelace: int, option: tuple[str, str] | None = None,
                asset: str = "") -> list[str]:
    check_min_utxo(address, lovelace, option, asset)
    value = f"{address} + {lovelace} lovelace" + (f" + 1 {asset}" if asset else "")
    return ["--tx-out", value, *(option or ())]


def build_tx(name: str, inputs: list[dict], fixed: list[tuple[str, int, tuple[str, str] | None, str]],
             change_address: str, extra: list[str] | None = None, deposit: int = 0,
             ref_script_size: int = 0) -> tuple[Path, str]:
    if not inputs:
        raise LaunchError(f"{name}: no funding inputs")
    fixed_total = sum(x[1] for x in fixed)
    total = sum(amount(row) for row in inputs)
    txraw = WALLET / f"{name}.txraw"
    signed = WALLET / f"{name}.tx"
    fee = 500_000
    for _ in range(6):
        change = total - fixed_total - deposit - fee
        if change < 1_500_000:
            raise LaunchError(f"{name}: insufficient ADA for outputs, deposit, fee, and change")
        args = ["transaction", "build-raw"]
        for row in inputs:
            args += ["--tx-in", ref_of(row)]
        for address, lovelace, option, asset in fixed:
            args += output_args(address, lovelace, option, asset)
        args += output_args(change_address, change)
        args += (extra or [])
        args += ["--fee", str(fee), "--protocol-params-file", str(WALLET / "protocol.json"),
                 "--out-file", str(txraw)]
        cli(*args)
        fee_args = ["transaction", "calculate-min-fee", "--tx-body-file", str(txraw),
                    "--protocol-params-file", str(WALLET / "protocol.json"), "--witness-count", "1"]
        if ref_script_size:
            fee_args += ["--reference-script-size", str(ref_script_size)]
        min_fee = int(json.loads(cli(*fee_args))["fee"])
        adjusted = min_fee + 50_000
        if adjusted == fee:
            break
        fee = adjusted
    else:
        raise LaunchError(f"{name}: fee did not converge")
    cli("transaction", "sign", "--tx-body-file", str(txraw),
        "--signing-key-file", str(WALLET / "payment.skey"), "--mainnet",
        "--out-file", str(signed))
    txid = re.search(r"[a-f0-9]{64}", cli("transaction", "txid", "--tx-file", str(signed)))
    if not txid:
        raise LaunchError(f"{name}: cardano-cli returned no transaction id")
    return signed, txid.group()


def run_stage(state: dict, name: str, builder) -> str:
    stages = state["stages"]
    if name not in stages:
        signed, txid = builder()
        stages[name] = {"txid": txid, "signed": str(signed)}
        atomic_json(STATE, state, private=True)
    record = stages[name]
    txid = record["txid"]
    saved_txid = re.search(r"[a-f0-9]{64}", cli("transaction", "txid", "--tx-file", record["signed"]))
    if not saved_txid or saved_txid.group() != txid:
        raise LaunchError(f"{name}: saved signed transaction does not match resume journal")
    print(f"{name}: {txid}", flush=True)
    if status(txid) < 2:
        try:
            submit(Path(record["signed"]), txid)
        except LaunchError as exc:
            if status(txid) == 0:
                raise LaunchError(f"{exc}; signed transaction retained for resume") from exc
        await_confirmed(txid)
    return txid


def script_address(name: str) -> str:
    return cli("address", "build", "--payment-script-file", str(ARTIFACTS / f"{name}.plutus"), "--mainnet")


def verify_ref(ref: str, expected_hash: str, expected_addr: str) -> None:
    row = utxo(ref, wait=True)
    script = row.get("reference_script") or {}
    if row.get("address") != expected_addr or script.get("hash") != expected_hash:
        raise LaunchError(f"Reference script UTxO {ref} does not match expected address/hash")


def prepare_book(seed: str) -> dict:
    config = read_json(CONFIG)
    if config["network"] != "mainnet":
        raise LaunchError("config/network.mainnet.json is not mainnet")
    if config["denom_lovelace"] != 10_000_000 or config["max_fee_per_mix_lovelace"] != 800_000 or config["fee_shard_target"] != 10:
        raise LaunchError("Mainnet config changed; review immutable protocol parameters before launch")
    if BOOK.exists():
        book = read_json(BOOK)
        if book.get("network") != "mainnet" or book.get("seedUtxoRef") != seed:
            raise LaunchError("Existing mainnet address book is for another seed or deployment")
        if book.get("protocol") != {"denom_lovelace": config["denom_lovelace"],
                                   "max_fee_per_mix_lovelace": config["max_fee_per_mix_lovelace"],
                                   "fee_shard_target": config["fee_shard_target"]}:
            raise LaunchError("Existing mainnet address book protocol differs from config")
        if book.get("mixLogicScriptHash"):
            return book
    else:
        book = {"network": "mainnet", "seedUtxoRef": seed,
            "protocol": {"denom_lovelace": config["denom_lovelace"],
                         "max_fee_per_mix_lovelace": config["max_fee_per_mix_lovelace"],
                         "fee_shard_target": config["fee_shard_target"]}}
    atomic_json(BOOK, book)
    env = os.environ.copy()
    env.update({"NETWORK": "mainnet", "LOVEJOIN_MAINNET_CONFIRM": "yes",
                "LOVEJOIN_BOOTSTRAP_SKIP_ENV": "1", "SEED": seed})
    print("Compiling and parameterizing mainnet validators", flush=True)
    subprocess.run([str(BOOTSTRAP / "00-build-reference.sh")], cwd=ROOT, env=env, check=True)
    return read_json(BOOK)


def save_book(book: dict) -> None:
    atomic_json(BOOK, book)


def select_sweep_inputs(rows: list[dict], protected: set[str]) -> list[dict]:
    spendable = [row for row in rows if ref_of(row) not in protected]
    if any(row.get("reference_script") for row in spendable):
        raise LaunchError("Unexpected reference-script UTxO at launch wallet; sweep halted")
    for row in spendable:
        amount(row)  # Reject native assets before constructing a sweep transaction.
    return spendable


def launch(return_address: str, confirmed: bool, mode: str = "core") -> None:
    if not confirmed or os.environ.get("LOVEJOIN_MAINNET_CONFIRM") != "yes":
        raise LaunchError("Launch requires --confirm-mainnet-launch and LOVEJOIN_MAINNET_CONFIRM=yes")
    if mode not in MIN_LAUNCH_LOVELACE:
        raise LaunchError(f"Unknown launch mode: {mode}")
    split = CORE_SPLIT if mode == "core" else FULL_SPLIT
    validate_mainnet_address(return_address)
    address = wallet_address()
    if return_address == address:
        raise LaunchError("Return address must differ from the one-time launch wallet")
    if STATE.exists():
        state = read_json(STATE)
        if state.get("returnAddress") != return_address:
            raise LaunchError("Return address differs from saved launch journal; refusing to resume")
        if state.get("mode") != mode:
            raise LaunchError("Launch mode differs from saved launch journal; refusing to resume")
    else:
        if BOOK.exists() and read_json(BOOK).get("referenceUtxoRef"):
            raise LaunchError("Mainnet address book already contains a deployment")
        state = {"network": "mainnet", "mode": mode, "returnAddress": return_address, "stages": {}}
        atomic_json(STATE, state, private=True)
    params = protocol_params()
    stages = state["stages"]
    if "prep" not in stages:
        initial = address_utxos(address)
        total = sum(amount(row) for row in initial)
        minimum = MIN_LAUNCH_LOVELACE[mode]
        if total < minimum:
            raise LaunchError(f"Fund at least {minimum / 1_000_000:.0f} ADA for {mode} launch; found {total / 1_000_000:.6f}")
        if any(row.get("reference_script") for row in initial):
            raise LaunchError("Launch wallet already contains reference scripts")
        def build_prep():
            fixed = [(address, value, None, "") for value in split]
            return build_tx("prep", initial, fixed, address)
        prep_tx = run_stage(state, "prep", build_prep)
    else:
        prep_tx = run_stage(state, "prep", lambda: (_ for _ in ()).throw(AssertionError()))
    prep_refs = [f"{prep_tx}#{i}" for i in range(len(split))]
    for i, expected in enumerate(split):
        # Earlier stage inputs may already be spent on resume.
        if ((i == 1 and "sweep" not in stages) or (i == 0 and "publish_mix_box" not in stages)
                or (i == 2 and "mint" not in stages) or (i == 3 and "shards" not in stages)):
            row = utxo(prep_refs[i], wait=True)
            if int(row["value"]) != expected or row["address"] != address:
                raise LaunchError(f"Unexpected preparation output at {prep_refs[i]}")
    book = prepare_book(prep_refs[2])
    for field in ("referenceNftPolicy", "referenceNftAssetName", "referenceHolderScriptHash",
                  "mixLogicScriptHash", "mixBoxScriptHash", "feeScriptHash"):
        if not book.get(field):
            raise LaunchError(f"Missing parameterized contract field: {field}")
    if book["referenceNftAssetName"] != ASSET_NAME:
        raise LaunchError("Unexpected reference NFT name")
    preprod_holder = read_json(ROOT / "artifacts" / "preprod" / "addresses.json")["referenceHolderScriptHash"]
    if book["referenceHolderScriptHash"] != preprod_holder:
        raise LaunchError("Parameter-free reference holder bytecode differs from live Preprod")
    for script, field in (("reference_holder", "referenceHolderScriptHash"),
                          ("one_shot_mint", "referenceNftPolicy"),
                          ("mix_logic", "mixLogicScriptHash"),
                          ("mix_box", "mixBoxScriptHash"),
                          ("fee_contract", "feeScriptHash")):
        actual = cli("transaction", "policyid", "--script-file", str(ARTIFACTS / f"{script}.plutus"))
        if actual != book[field]:
            raise LaunchError(f"{script} bytecode hash differs from mainnet address book")
    book.setdefault("deploymentTxs", {})["prep"] = prep_tx
    save_book(book)

    previous = prep_refs[0]
    for tag, script, hash_field in (("publish_mix_box", "mix_box", "mixBoxScriptHash"),
                                    ("publish_mix_logic", "mix_logic", "mixLogicScriptHash"),
                                    ("publish_fee_contract", "fee_contract", "feeScriptHash")):
        def build_publish(ref=previous, tag=tag, script=script):
            fixed = [(address, PUBLISH_LOVELACE,
                      ("--tx-out-reference-script-file", str(ARTIFACTS / f"{script}.plutus")), "")]
            return build_tx(tag, [utxo(ref, wait=True)], fixed, address)
        txid = run_stage(state, tag, build_publish)
        ref = f"{txid}#0"
        verify_ref(ref, book[hash_field], address)
        book.setdefault("referenceScriptUtxos", {})[script] = ref
        book["deploymentTxs"][tag] = txid
        book["stage1ChangeUtxo"] = f"{txid}#1"
        save_book(book)
        previous = f"{txid}#1"

    logic_ref = book["referenceScriptUtxos"]["mix_logic"]
    logic_size = int(utxo(logic_ref)["reference_script"]["size"])
    def build_register():
        cert = WALLET / "mix_logic-stake-registration.cert"
        cli("stake-address", "registration-certificate", "--stake-script-file",
            str(ARTIFACTS / "mix_logic.plutus"), "--key-reg-deposit-amt",
            str(params["stakeAddressDeposit"]), "--out-file", str(cert))
        def extra_for_budget(budget: str) -> list[str]:
            return ["--tx-in-collateral", prep_refs[1],
                    "--tx-total-collateral", "2000000",
                    "--tx-out-return-collateral", f"{address} + 8000000 lovelace",
                    "--certificate-file", str(cert), "--certificate-tx-in-reference", logic_ref,
                    "--certificate-plutus-script-v3", "--certificate-reference-tx-in-redeemer-value",
                    '{"constructor":0,"fields":[]}',
                    "--certificate-reference-tx-in-execution-units", budget]
        return build_evaluated_tx("register", "certificate:0", [utxo(previous, wait=True)],
                                  [], address, extra_for_budget, params,
                                  params["stakeAddressDeposit"], logic_size)
    register_tx = run_stage(state, "register", build_register)
    book["mixLogicRegisterTx"] = register_tx
    book["deploymentTxs"]["register"] = register_tx
    book.setdefault("scriptEvaluation", {})["register"] = read_json(WALLET / "register.evaluation.json")
    save_book(book)

    holder_addr = script_address("reference_holder")
    asset = f"{book['referenceNftPolicy']}.{ASSET_NAME}"
    datum = {"constructor": 0, "fields": [
        {"int": book["protocol"]["denom_lovelace"]},
        {"int": book["protocol"]["max_fee_per_mix_lovelace"]},
        {"bytes": book["mixBoxScriptHash"]},
        {"bytes": book["mixLogicScriptHash"]},
        {"bytes": book["feeScriptHash"]},
    ]}
    datum_file = WALLET / "reference_datum.json"
    atomic_json(datum_file, datum, private=True)
    def build_mint():
        def extra_for_budget(budget: str) -> list[str]:
            return ["--tx-in-collateral", prep_refs[1],
                    "--tx-total-collateral", "2000000",
                    "--tx-out-return-collateral", f"{address} + 8000000 lovelace",
                    "--mint", f"1 {asset}", "--mint-script-file", str(ARTIFACTS / "one_shot_mint.plutus"),
                    "--mint-redeemer-value", '{"constructor":0,"fields":[]}',
                    "--mint-execution-units", budget]
        fixed = [(holder_addr, LOCKED_LOVELACE,
                  ("--tx-out-inline-datum-file", str(datum_file)), asset)]
        return build_evaluated_tx("mint", "mint:0", [utxo(prep_refs[2], wait=True)],
                                  fixed, address, extra_for_budget, params)
    mint_tx = run_stage(state, "mint", build_mint)
    nft_ref = f"{mint_tx}#0"
    nft = utxo(nft_ref, wait=True)
    assets = nft.get("asset_list") or []
    if nft.get("address") != holder_addr or not any(
        a.get("policy_id") == book["referenceNftPolicy"] and a.get("asset_name") == ASSET_NAME
        and int(a.get("quantity", 0)) == 1 for a in assets
    ) or (nft.get("inline_datum") or {}).get("value") != datum:
        raise LaunchError("Confirmed reference NFT or inline datum failed verification")
    book["referenceUtxoRef"] = nft_ref
    book["deploymentTxs"]["mint"] = mint_tx
    book.setdefault("scriptEvaluation", {})["mint"] = read_json(WALLET / "mint.evaluation.json")
    save_book(book)

    if mode == "full":
        fee_addr = script_address("fee_contract")
        unit_file = WALLET / "unit_datum.json"
        atomic_json(unit_file, {"constructor": 0, "fields": []}, private=True)
        def build_shards():
            fixed = [(fee_addr, SHARD_LOVELACE,
                      ("--tx-out-inline-datum-file", str(unit_file)), "") for _ in range(SHARD_COUNT)]
            return build_tx("shards", [utxo(prep_refs[3], wait=True)], fixed, address)
        shards_tx = run_stage(state, "shards", build_shards)
        shard_refs = [f"{shards_tx}#{i}" for i in range(SHARD_COUNT)]
        for ref in shard_refs:
            shard = utxo(ref, wait=True)
            if shard.get("address") != fee_addr or int(shard["value"]) != SHARD_LOVELACE or (shard.get("inline_datum") or {}).get("value") != {"constructor": 0, "fields": []}:
                raise LaunchError(f"Fee shard verification failed: {ref}")
        book["feeShardUtxos"] = shard_refs
        book["deploymentTxs"]["shards"] = shards_tx
        save_book(book)

    else:
        book["feeShardUtxos"] = []
        save_book(book)

    protected = set(book["referenceScriptUtxos"].values())
    def build_sweep():
        spendable = select_sweep_inputs(address_utxos(address), protected)
        return build_tx("sweep", spendable, [], return_address)
    sweep_tx = run_stage(state, "sweep", build_sweep)
    remaining = [row for row in address_utxos(address) if ref_of(row) not in protected]
    if remaining:
        raise LaunchError(f"Sweep confirmed but {len(remaining)} spendable wallet UTxOs remain")
    book["deploymentTxs"]["sweep"] = sweep_tx
    save_book(book)
    print(f"Mainnet launch complete. Canonical address book: {BOOK}")
    print(f"Remaining ADA sent to: {return_address} (tx {sweep_tx})")
    print("Review artifacts/mainnet/addresses.json before committing it. Do not commit wallets/.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("wallet", help="generate the isolated one-time mainnet wallet offline")
    sub.add_parser("status", help="read mainnet launch wallet balance via Koios")
    launch_parser = sub.add_parser("launch", help="submit/resume the mainnet bootstrap")
    launch_parser.add_argument("--return-address", required=True)
    launch_parser.add_argument("--mode", choices=("core", "full"), default="core",
                               help="core omits fee shards (105 ADA); full funds ten (160 ADA)")
    launch_parser.add_argument("--confirm-mainnet-launch", action="store_true")
    args = parser.parse_args()
    if args.command == "wallet":
        make_wallet()
    elif args.command == "status":
        show_status()
    else:
        launch(args.return_address, args.confirm_mainnet_launch, args.mode)


if __name__ == "__main__":
    try:
        main()
    except (LaunchError, subprocess.CalledProcessError, ValueError, KeyError) as exc:
        print(f"koios-launch: {exc}", file=sys.stderr)
        sys.exit(1)
