#!/usr/bin/env python3
"""Preprod launch of the token-pool contracts with offline cardano-cli and public Koios.

Rehearses the generalized (token-mixing) contracts: mints a test token under a
native policy locked to the launch key, parameterizes the validators into
artifacts/preprod-token/, publishes the three reference scripts to a base
address of the launch key (recoverable, but invisible to an enterprise-address
wallet's coin selection), registers the mix_logic stake credential, mints the
reference NFT with the eight-field ReferenceDatum. Like the mainnet launch it
funds no fee shards, so mixes are wallet-paid.

Preprod only. Every signed transaction is journaled before submission, so an
interrupted launch resumes by running `launch` again. The wallet, signed
transactions, and journal stay in the gitignored wallets/ directory.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
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
WALLET = BOOTSTRAP / "wallets" / "token-preprod"
ARTIFACTS = ROOT / "artifacts" / "preprod-token"
BOOK = ARTIFACTS / "addresses.json"
STATE = WALLET / "launch-state.json"
KOIOS = "https://preprod.koios.rest/api/v1"
NETWORK_ARGS = ("--testnet-magic", "1")
REF_NFT_NAME = "6c6f76656a6f696e"  # "lovejoin"; one_shot_mint pins it

# The pool token. Q = 10^16 is above 2^53, so the on-chain box value uses an
# 8-byte CBOR integer, yet every sum mesh's Number-based coin selection forms
# stays a multiple of 2^16 and is exact in a double.
TOKEN_TICKER = "LJTEST"
TOKEN_NAME = TOKEN_TICKER.encode().hex()
TOKEN_QUANTITY = 10**16
TOKEN_SUPPLY = 10**18
BOX_LOVELACE = 2_000_000
# one_shot_mint requires max_fee_per_mix < box_lovelace.
MAX_FEE_PER_MIX_LOVELACE = 1_500_000
MAX_N_SHARD = 3
MAX_N_WALLET = 4

# Prep outputs: publication + registration budget, collateral, mint seed, and
# the minted token supply (lovelace carried alongside it).
SPLIT = (50_000_000, 5_000_000, 5_000_000, 2_000_000)
TOTAL_COLLATERAL = 2_000_000
MIN_LAUNCH_LOVELACE = 70_000_000
# A box-fee withdraw pays its fee out of the box; warn when little is left.
MIN_WITHDRAW_HEADROOM = 700_000
CONFIRM_TIMEOUT = 600


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
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    for attempt in range(3):
        try:
            request = urllib.request.Request(KOIOS + path, data=data, headers=headers,
                                             method="POST" if data is not None else "GET")
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read(4000).decode(errors="replace")
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
    except urllib.error.HTTPError as exc:
        raise LaunchError(f"Koios submit {expected_txid}: HTTP {exc.code}: "
                          f"{exc.read(4000).decode(errors='replace')}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise LaunchError(f"Koios submit {expected_txid}: {exc}") from exc
    if expected_txid not in answer:
        raise LaunchError(f"Koios returned unexpected txid for {expected_txid}: {answer[:200]}")
    print(f"  submitted {expected_txid}", flush=True)


def confirmations(txid: str) -> int:
    for row in koios("/tx_status", {"_tx_hashes": [txid]}):
        if row.get("tx_hash") == txid:
            return int(row.get("num_confirmations") or 0)
    return 0


def await_confirmed(txid: str) -> None:
    deadline = time.monotonic() + CONFIRM_TIMEOUT
    while time.monotonic() < deadline:
        if confirmations(txid) >= 1:
            print(f"  confirmed {txid}", flush=True)
            return
        time.sleep(8)
    raise LaunchError(f"{txid} is not confirmed; rerun launch to resume")


def address_utxos(address: str) -> list[dict]:
    rows = koios("/address_utxos", {"_addresses": [address], "_extended": True})
    if not isinstance(rows, list) or len(rows) >= 1000:
        raise LaunchError("Koios address_utxos returned an unexpected response")
    return rows


def utxo(ref: str) -> dict:
    deadline = time.monotonic() + 120
    while True:
        for row in koios("/utxo_info", {"_utxo_refs": [ref], "_extended": True}):
            if f"{row.get('tx_hash')}#{row.get('tx_index')}" == ref:
                if row.get("is_spent") is not False:
                    raise LaunchError(f"Expected unspent UTxO is spent: {ref}")
                return row
        if time.monotonic() >= deadline:
            raise LaunchError(f"Expected unspent UTxO missing from Koios: {ref}")
        time.sleep(5)


def ref_of(row: dict) -> str:
    return f"{row['tx_hash']}#{row['tx_index']}"


def ada_only(row: dict) -> int:
    if row.get("asset_list") or row.get("reference_script"):
        raise LaunchError(f"{ref_of(row)} carries tokens or a script; the launcher spends ADA-only UTxOs")
    return int(row["value"])


def wallet_address() -> str:
    for name in ("payment.skey", "payment.vkey", "payment.addr"):
        if not (WALLET / name).is_file():
            raise LaunchError(f"Launch wallet file missing: {WALLET / name}")
    address = (WALLET / "payment.addr").read_text().strip()
    derived = cli("address", "build", "--payment-verification-key-file",
                  str(WALLET / "payment.vkey"), *NETWORK_ARGS)
    if address != derived or not address.startswith("addr_test1"):
        raise LaunchError("payment.addr does not match payment.vkey on Preprod")
    return address


def key_hash() -> str:
    return cli("address", "key-hash", "--payment-verification-key-file", str(WALLET / "payment.vkey"))


def park_address() -> str:
    """Base address of the launch key: holds the reference scripts.

    A payment-key-only wallet (the integration test's) lists only its
    enterprise address, so its coin selection and collateral choice never
    touch these UTxOs; the launch key can still spend them.
    """
    return cli("address", "build", "--payment-verification-key-file", str(WALLET / "payment.vkey"),
               "--stake-key-hash", key_hash(), *NETWORK_ARGS)


def token_policy() -> tuple[Path, str]:
    script = WALLET / "token-policy.script"
    atomic_json(script, {"type": "sig", "keyHash": key_hash()}, private=True)
    return script, cli("transaction", "policyid", "--script-file", str(script))


def protocol_params() -> dict:
    p = koios("/cli_protocol_params")
    required = ("costModels", "executionUnitPrices", "maxTxExecutionUnits", "stakeAddressDeposit",
                "txFeeFixed", "txFeePerByte", "utxoCostPerByte", "collateralPercentage", "maxTxSize")
    if not isinstance(p, dict) or any(p.get(field) is None for field in required):
        raise LaunchError("Koios cli_protocol_params lacks a required field")
    atomic_json(WALLET / "protocol.json", p, private=True)
    return p


def evaluate_tx(signed: Path, expected_validator: str) -> tuple[int, int]:
    request = {"jsonrpc": "2.0", "method": "evaluateTransaction",
               "params": {"transaction": {"cbor": read_json(signed)["cborHex"]}}}
    for attempt in range(6):
        try:
            response = koios("/ogmios", request)
            if not isinstance(response, dict) or response.get("error"):
                raise LaunchError(f"Koios Ogmios evaluation failed: {response}")
            break
        except LaunchError as exc:
            if "unknown" not in str(exc).lower() or attempt == 5:
                raise
            time.sleep(10)
    result = response.get("result")
    if not isinstance(result, list) or len(result) != 1:
        raise LaunchError(f"Koios Ogmios returned unexpected redeemers: {result}")
    pointer = result[0].get("validator") or {}
    purpose = "certificate" if pointer.get("purpose") == "publish" else pointer.get("purpose")
    if f"{purpose}:{pointer.get('index')}" != expected_validator:
        raise LaunchError(f"Koios Ogmios returned unexpected redeemer: {pointer}")
    cpu, memory = int(result[0]["budget"]["cpu"]), int(result[0]["budget"]["memory"])
    print(f"  evaluated {expected_validator}: {cpu} steps, {memory} memory", flush=True)
    return cpu, memory


def min_utxo(address: str, lovelace: int, assets: str = "", options: tuple[str, ...] = ()) -> int:
    value = f"{address} + {lovelace} lovelace" + (f" + {assets}" if assets else "")
    response = cli("transaction", "calculate-min-required-utxo", "--protocol-params-file",
                   str(WALLET / "protocol.json"), "--tx-out", value, *options)
    match = re.search(r"\d+", response)
    if not match:
        raise LaunchError(f"cardano-cli returned no minimum UTxO value: {response}")
    return int(match.group())


class Out:
    """One fixed transaction output."""

    def __init__(self, address: str, lovelace: int, assets: str = "", options: tuple[str, ...] = ()):
        self.address, self.lovelace, self.assets, self.options = address, lovelace, assets, options

    def args(self) -> list[str]:
        required = min_utxo(self.address, self.lovelace, self.assets, self.options)
        if self.lovelace < required:
            raise LaunchError(f"Output at {self.address} needs {required} lovelace; planned {self.lovelace}")
        value = f"{self.address} + {self.lovelace} lovelace" + (f" + {self.assets}" if self.assets else "")
        return ["--tx-out", value, *self.options]


def build_tx(name: str, inputs: list[dict], fixed: list[Out], change_address: str,
             extra: list[str] | None = None, deposit: int = 0, ref_script_size: int = 0) -> tuple[Path, str]:
    params = read_json(WALLET / "protocol.json")
    total = sum(ada_only(row) for row in inputs)
    txraw, signed = WALLET / f"{name}.txraw", WALLET / f"{name}.tx"
    fee = 500_000
    for _ in range(6):
        change = total - sum(o.lovelace for o in fixed) - deposit - fee
        if change < 1_500_000:
            raise LaunchError(f"{name}: insufficient ADA for outputs, deposit, fee, and change")
        args = ["transaction", "build-raw"]
        for row in inputs:
            args += ["--tx-in", ref_of(row)]
        for out in fixed:
            args += out.args()
        args += Out(change_address, change).args()
        args += (extra or [])
        args += ["--fee", str(fee), "--protocol-params-file", str(WALLET / "protocol.json"),
                 "--out-file", str(txraw)]
        cli(*args)
        fee_args = ["transaction", "calculate-min-fee", "--tx-body-file", str(txraw),
                    "--protocol-params-file", str(WALLET / "protocol.json"), "--witness-count", "1"]
        if ref_script_size:
            fee_args += ["--reference-script-size", str(ref_script_size)]
        adjusted = int(json.loads(cli(*fee_args))["fee"]) + 50_000
        if adjusted == fee:
            break
        fee = adjusted
    else:
        raise LaunchError(f"{name}: fee did not converge")
    if extra and "--tx-total-collateral" in extra:
        provided = int(extra[extra.index("--tx-total-collateral") + 1])
        if provided < (fee * int(params["collateralPercentage"]) + 99) // 100:
            raise LaunchError(f"{name}: collateral {provided} is below the required amount")
    cli("transaction", "sign", "--tx-body-file", str(txraw),
        "--signing-key-file", str(WALLET / "payment.skey"), *NETWORK_ARGS, "--out-file", str(signed))
    if len(bytes.fromhex(read_json(signed)["cborHex"])) > int(params["maxTxSize"]):
        raise LaunchError(f"{name}: signed transaction exceeds the maximum size")
    txid = re.search(r"[a-f0-9]{64}", cli("transaction", "txid", "--tx-file", str(signed)))
    if not txid:
        raise LaunchError(f"{name}: cardano-cli returned no transaction id")
    return signed, txid.group()


def build_evaluated_tx(name: str, expected_validator: str, inputs: list[dict], fixed: list[Out],
                       change_address: str, extra_for_budget, params: dict, deposit: int = 0,
                       ref_script_size: int = 0) -> tuple[Path, str]:
    # Ogmios evaluates the zero-budget draft; rebuild with the measured units
    # plus headroom and re-evaluate the final shape.
    cpu = memory = 0
    for _ in range(4):
        signed, txid = build_tx(name, inputs, fixed, change_address,
                                extra_for_budget(f"({cpu},{memory})"), deposit, ref_script_size)
        used_cpu, used_memory = evaluate_tx(signed, expected_validator)
        if cpu >= used_cpu and memory >= used_memory:
            atomic_json(WALLET / f"{name}.evaluation.json", {
                "txid": txid, "validator": expected_validator,
                "used": {"steps": used_cpu, "memory": used_memory},
                "assigned": {"steps": cpu, "memory": memory}}, private=True)
            return signed, txid
        cpu = max(used_cpu + 1_000_000, (used_cpu * 125 + 99) // 100)
        memory = max(used_memory + 5_000, (used_memory * 125 + 99) // 100)
        limits = params["maxTxExecutionUnits"]
        if cpu > int(limits["steps"]) or memory > int(limits["memory"]):
            raise LaunchError(f"{name}: evaluated script budget exceeds the network limit")
    raise LaunchError(f"{name}: evaluated script budget did not stabilize")


def prepare_stage(state: dict, name: str, builder) -> str:
    """Persist an exact signed transaction before any submission."""
    stages = state["stages"]
    if name not in stages:
        signed, txid = builder()
        stages[name] = {"txid": txid, "signed": str(signed),
                        "signedSha256": hashlib.sha256(signed.read_bytes()).hexdigest()}
        atomic_json(STATE, state, private=True)
    record = stages[name]
    if record["signedSha256"] != hashlib.sha256(Path(record["signed"]).read_bytes()).hexdigest():
        raise LaunchError(f"{name}: saved signed transaction differs from the journal")
    return record["txid"]


def run_stage(state: dict, name: str, builder) -> str:
    txid = prepare_stage(state, name, builder)
    print(f"{name}: {txid}", flush=True)
    if confirmations(txid) == 0:
        try:
            submit(Path(state["stages"][name]["signed"]), txid)
        except LaunchError as exc:
            if confirmations(txid) == 0:
                raise LaunchError(f"{exc}; signed transaction kept for resume") from exc
        await_confirmed(txid)
    return txid


def script_address(name: str) -> str:
    return cli("address", "build", "--payment-script-file", str(ARTIFACTS / f"{name}.plutus"), *NETWORK_ARGS)


def plutus_size(name: str) -> int:
    return len(read_json(ARTIFACTS / f"{name}.plutus")["cborHex"]) // 2


def protocol_book() -> dict:
    return {"box_lovelace": BOX_LOVELACE,
            "token": {"policy": "", "name": TOKEN_NAME, "quantity": str(TOKEN_QUANTITY),
                      "ticker": TOKEN_TICKER, "decimals": 0},
            "max_fee_per_mix_lovelace": MAX_FEE_PER_MIX_LOVELACE,
            "max_n_shard": MAX_N_SHARD, "max_n_wallet": MAX_N_WALLET}


def build_contracts(seed: str, policy_id: str) -> dict:
    """Parameterize the validators for this seed with 00-build-reference.sh."""
    protocol = protocol_book()
    protocol["token"]["policy"] = policy_id
    if BOOK.exists():
        book = read_json(BOOK)
        if book.get("seedUtxoRef") != seed or book.get("protocol") != protocol:
            raise LaunchError(f"{BOOK} describes another launch; move it aside to start over")
        if book.get("mixLogicScriptHash"):
            return book
    atomic_json(BOOK, {"network": "preprod", "seedUtxoRef": seed, "protocol": protocol})
    env = os.environ.copy()
    env.update({"NETWORK": "preprod", "LOVEJOIN_BOOTSTRAP_SKIP_ENV": "1", "SEED": seed,
                "REF_NFT_ASSET_NAME": REF_NFT_NAME, "LOVEJOIN_ARTIFACTS_DIR": str(ARTIFACTS)})
    env.pop("LOVEJOIN_BOOTSTRAP_NETWORK_LIB", None)
    print("Compiling and parameterizing the token-pool validators", flush=True)
    subprocess.run([str(BOOTSTRAP / "00-build-reference.sh")], cwd=ROOT, env=env, check=True)
    book = read_json(BOOK)
    book["aikenVersion"] = subprocess.run(["aiken", "--version"], text=True, stdout=subprocess.PIPE,
                                          check=True).stdout.strip()
    atomic_json(BOOK, book)
    return book


def check_box_fits(mix_address: str, token_unit: str, wallet: str) -> None:
    datum = WALLET / "sample-mix-datum.json"
    atomic_json(datum, {"constructor": 0, "fields": [{"bytes": "a" * 96}, {"bytes": "b" * 96}]},
                private=True)
    assets = f"{TOKEN_QUANTITY} {token_unit}"
    box_min = min_utxo(mix_address, BOX_LOVELACE, assets, ("--tx-out-inline-datum-file", str(datum)))
    if box_min > BOX_LOVELACE:
        raise LaunchError(f"A mix-box needs {box_min} lovelace; box_lovelace is {BOX_LOVELACE}")
    headroom = BOX_LOVELACE - min_utxo(wallet, BOX_LOVELACE, assets)
    print(f"  mix-box minimum {box_min}; box-fee withdraw headroom {headroom} lovelace", flush=True)
    if headroom < MIN_WITHDRAW_HEADROOM:
        print(f"  WARNING: box-fee withdraw headroom is below {MIN_WITHDRAW_HEADROOM} lovelace", flush=True)


@contextmanager
def launch_lock():
    with open(WALLET / "launch.lock", "a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise LaunchError("Another launch process holds the wallet lock") from exc
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def show_status() -> None:
    address = wallet_address()
    rows = address_utxos(address)
    print(f"Launch address: {address}\nUTxOs: {len(rows)}\n"
          f"tADA: {sum(int(r['value']) for r in rows) / 1_000_000:.6f}")
    if STATE.exists():
        print("Recorded stages:", ", ".join(read_json(STATE).get("stages", {})) or "none")


def launch() -> None:
    address = wallet_address()
    with launch_lock():
        launch_locked(address)


def launch_locked(address: str) -> None:
    if STATE.exists():
        state = read_json(STATE)
        if state.get("network") != "preprod" or state.get("walletAddress") != address:
            raise LaunchError("Saved journal belongs to another wallet or network")
    else:
        if BOOK.exists() and read_json(BOOK).get("referenceUtxoRef"):
            raise LaunchError(f"{BOOK} already records a deployment")
        state = {"network": "preprod", "walletAddress": address, "stages": {}}
        atomic_json(STATE, state, private=True)
    params = protocol_params()
    stages = state["stages"]
    policy_script, policy_id = token_policy()
    token_unit = f"{policy_id}.{TOKEN_NAME}"

    def build_prep():
        rows = [r for r in address_utxos(address) if not r.get("asset_list") and not r.get("reference_script")]
        total = sum(int(r["value"]) for r in rows)
        if total < MIN_LAUNCH_LOVELACE:
            raise LaunchError(f"Fund at least {MIN_LAUNCH_LOVELACE / 1e6:.0f} tADA; found {total / 1e6:.6f}")
        fixed = [Out(address, lovelace) for lovelace in SPLIT[:3]]
        fixed.append(Out(address, SPLIT[3], f"{TOKEN_SUPPLY} {token_unit}"))
        return build_tx("prep", rows, fixed, address,
                        ["--mint", f"{TOKEN_SUPPLY} {token_unit}", "--mint-script-file", str(policy_script)])
    prep_tx = prepare_stage(state, "prep", build_prep)
    prep = [f"{prep_tx}#{i}" for i in range(len(SPLIT) + 1)]  # last one is the change

    # Compile and check the box fits BEFORE anything is submitted. The saved
    # prep body already fixes the mint seed (prep#2).
    book = build_contracts(prep[2], policy_id)
    for script, field in (("reference_holder", "referenceHolderScriptHash"),
                          ("one_shot_mint", "referenceNftPolicy"),
                          ("mix_logic", "mixLogicScriptHash"),
                          ("mix_box", "mixBoxScriptHash"),
                          ("fee_contract", "feeScriptHash")):
        if cli("transaction", "policyid", "--script-file", str(ARTIFACTS / f"{script}.plutus")) != book[field]:
            raise LaunchError(f"{script} bytecode hash differs from {BOOK}")
    mix_address = script_address("mix_box")
    holder_address = script_address("reference_holder")
    check_box_fits(mix_address, token_unit, address)

    run_stage(state, "prep", lambda: (_ for _ in ()).throw(AssertionError()))
    book.setdefault("deploymentTxs", {})["prep"] = prep_tx
    book["testToken"] = {"unit": token_unit.replace(".", ""), "supply": str(TOKEN_SUPPLY),
                         "policyScript": {"type": "sig", "keyHash": key_hash()}}
    atomic_json(BOOK, book)

    park = park_address()
    book["referenceScriptParkAddress"] = park
    previous = prep[0]
    for script, hash_field in (("mix_box", "mixBoxScriptHash"), ("mix_logic", "mixLogicScriptHash"),
                               ("fee_contract", "feeScriptHash")):
        option = ("--tx-out-reference-script-file", str(ARTIFACTS / f"{script}.plutus"))
        locked = min_utxo(park, 1, options=option)
        def build_publish(ref=previous, script=script, option=option, locked=locked):
            return build_tx(f"publish_{script}", [utxo(ref)], [Out(park, locked, options=option)], address)
        txid = run_stage(state, f"publish_{script}", build_publish)
        row = utxo(f"{txid}#0")
        if (row["address"] != park or (row.get("reference_script") or {}).get("hash") != book[hash_field]):
            raise LaunchError(f"Reference script UTxO {txid}#0 does not match {script}")
        book.setdefault("referenceScriptUtxos", {})[script] = f"{txid}#0"
        book.setdefault("referenceScriptSizes", {})[script] = plutus_size(script)
        book["deploymentTxs"][f"publish_{script}"] = txid
        atomic_json(BOOK, book)
        previous = f"{txid}#1"

    collateral_args = ["--tx-in-collateral", prep[1], "--tx-total-collateral", str(TOTAL_COLLATERAL),
                       "--tx-out-return-collateral", f"{address} + {SPLIT[1] - TOTAL_COLLATERAL} lovelace"]
    logic_ref = book["referenceScriptUtxos"]["mix_logic"]
    logic_size = int(utxo(logic_ref)["reference_script"]["size"])
    def build_register():
        cert = WALLET / "mix_logic-stake-registration.cert"
        cli("stake-address", "registration-certificate", "--stake-script-file",
            str(ARTIFACTS / "mix_logic.plutus"), "--key-reg-deposit-amt",
            str(params["stakeAddressDeposit"]), "--out-file", str(cert))
        def extra_for_budget(budget: str) -> list[str]:
            return [*collateral_args, "--certificate-file", str(cert),
                    "--certificate-tx-in-reference", logic_ref, "--certificate-plutus-script-v3",
                    "--certificate-reference-tx-in-redeemer-value", '{"constructor":0,"fields":[]}',
                    "--certificate-reference-tx-in-execution-units", budget]
        return build_evaluated_tx("register", "certificate:0", [utxo(previous)], [], address,
                                  extra_for_budget, params, int(params["stakeAddressDeposit"]), logic_size)
    register_tx = run_stage(state, "register", build_register)
    book["mixLogicRegisterTx"] = register_tx
    book["deploymentTxs"]["register"] = register_tx
    atomic_json(BOOK, book)

    nft = f"{book['referenceNftPolicy']}.{REF_NFT_NAME}"
    datum = {"constructor": 0, "fields": [
        {"int": BOX_LOVELACE}, {"bytes": policy_id}, {"bytes": TOKEN_NAME}, {"int": TOKEN_QUANTITY},
        {"int": MAX_FEE_PER_MIX_LOVELACE}, {"bytes": book["mixBoxScriptHash"]},
        {"bytes": book["mixLogicScriptHash"]}, {"bytes": book["feeScriptHash"]}]}
    datum_file = WALLET / "reference_datum.json"
    atomic_json(datum_file, datum, private=True)
    datum_option = ("--tx-out-inline-datum-file", str(datum_file))
    def build_mint():
        locked = min_utxo(holder_address, 1, f"1 {nft}", datum_option)
        def extra_for_budget(budget: str) -> list[str]:
            return [*collateral_args, "--mint", f"1 {nft}",
                    "--mint-script-file", str(ARTIFACTS / "one_shot_mint.plutus"),
                    "--mint-redeemer-value", '{"constructor":0,"fields":[]}',
                    "--mint-execution-units", budget]
        return build_evaluated_tx("mint", "mint:0", [utxo(prep[2])],
                                  [Out(holder_address, locked, f"1 {nft}", datum_option)], address,
                                  extra_for_budget, params)
    mint_tx = run_stage(state, "mint", build_mint)
    reference = utxo(f"{mint_tx}#0")
    if (reference["address"] != holder_address
            or (reference.get("inline_datum") or {}).get("value") != datum):
        raise LaunchError("Confirmed reference NFT or inline datum failed verification")
    book["referenceUtxoRef"] = f"{mint_tx}#0"
    book["deploymentTxs"]["mint"] = mint_tx
    atomic_json(BOOK, book)

    book["feeShardUtxos"] = []
    atomic_json(BOOK, book)
    print(f"Token-pool launch complete. Address book: {BOOK}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="show the launch wallet balance and journal")
    sub.add_parser("launch", help="submit or resume the Preprod token-pool launch")
    args = parser.parse_args()
    if args.command == "status":
        show_status()
    else:
        launch()


if __name__ == "__main__":
    try:
        main()
    except (LaunchError, subprocess.CalledProcessError, ValueError, KeyError, OSError) as exc:
        print(f"koios-token-launch: {exc}", file=sys.stderr)
        sys.exit(1)
