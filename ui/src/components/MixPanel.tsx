// Mix screen — pick a subset of session-deposited boxes (or paste explicit
// refs), choose N, run a single Mix tx.
//
// Spec: docs/spec/09-milestones.md M4 — "Mix screen: pick boxes from the
// M3.5 my-boxes list (or paste explicit refs), choose N, run mix, show
// tx hash. Pool-wide random selection is M5/M6."
//
// Scope is intentionally minimal:
//   * No collateral-provider status indicator (M6).
//   * No N-width slider (M6 — the slider needs the calibrated max_n
//     surfaced from the protocol; for M4 we just type a number).
//   * No persistence of the new (a', b', y) per output across reloads —
//     the resulting box appears in My Boxes if the wallet still owns it,
//     but the SDK doesn't track which y_i went where. Owner ship survives
//     because b == [x]·a is invariant under re-randomization, and the
//     pool scanner re-derives ownership at fetch time (M6).

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserWallet } from "@meshsdk/core";
import {
  buildMixTx,
  type LovejoinAddresses,
  type BlockfrostProvider,
  type MixFeePayer,
  type MixInput,
  type Utxo,
} from "@lovejoin/sdk";

import type { Network } from "../lib/sdk.js";
import type { DepositedBox } from "./DepositPanel.js";

export interface MixPanelProps {
  network: Network;
  provider: BlockfrostProvider;
  addresses: LovejoinAddresses;
  wallet: BrowserWallet;
  /** Boxes from this session — the user picks 2..N from these. */
  myBoxes: ReadonlyArray<DepositedBox>;
  /**
   * Called when a Mix tx submits successfully — the new box ownership
   * survives via the same secret, but the on-chain ref + (a, b) change.
   * The parent updates "My Boxes" with the new shapes.
   */
  onMixed: (args: {
    txId: string;
    spent: ReadonlyArray<DepositedBox>;
    /** New (a', b') per output position 0..N-1. */
    newOutputs: ReadonlyArray<{ a: Uint8Array; b: Uint8Array; outputIndex: number }>;
  }) => void;
}

export function MixPanel({
  network,
  provider,
  addresses,
  wallet,
  myBoxes,
  onMixed,
}: MixPanelProps) {
  const { t } = useTranslation();
  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(new Set());
  const [nField, setNField] = useState<string>("2");
  const [feePayer, setFeePayer] = useState<MixFeePayer>("shard");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedBoxes = useMemo(
    () =>
      myBoxes.filter((b) => selectedRefs.has(`${b.txId}#${b.outputIndex}`)),
    [myBoxes, selectedRefs],
  );
  const n = Number.parseInt(nField, 10);
  const validN =
    Number.isInteger(n) && n >= 2 && selectedBoxes.length >= 2 && selectedBoxes.length === n;

  const toggle = (ref: string) => {
    setSelectedRefs((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSuccess(null);
    setError(null);
    try {
      if (selectedBoxes.length < 2) {
        throw new Error("pick at least 2 boxes");
      }
      const inputs: MixInput[] = selectedBoxes.map<MixInput>((b) => {
        // The UI only knows what we recorded at deposit time; reconstruct
        // a minimal Utxo with denom + the inline datum bytes. The SDK's
        // mesh layer will resolve the on-chain UTxO at build time.
        const utxo: Utxo = {
          ref: { txId: b.txId, outputIndex: b.outputIndex },
          // Address isn't strictly needed (the SDK rebuilds from script
          // hash) but mesh's MeshTxBuilder accepts the bech32 we pass for
          // its txIn(...) call. The UI stores the resolved address on
          // first deposit; until then mesh refetches via its fetcher,
          // which is wired through Blockfrost.
          address: "",
          lovelace: BigInt(addresses.protocol.denom_lovelace),
          assets: {},
          inlineDatum: null,
          referenceScript: null,
        };
        return {
          ref: { txId: b.txId, outputIndex: b.outputIndex },
          a: hexToBytes(b.aHex),
          b: hexToBytes(b.bHex),
          utxo,
        };
      });
      const result = await buildMixTx({
        network: network as "preprod" | "preview" | "mainnet",
        inputs,
        wallet,
        provider,
        addresses,
        feePayer,
      });
      const newOutputs = result.plan.outputs.map((o, i) => ({
        a: o.a,
        b: o.b,
        outputIndex: i,
      }));
      onMixed({
        txId: result.txId,
        spent: selectedBoxes,
        newOutputs,
      });
      setSuccess(t("mix.success", { txId: result.txId, n: result.plan.n }));
      setSelectedRefs(new Set());
    } catch (e) {
      setError(t("mix.error", { message: (e as Error).message }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">{t("mix.section_title")}</h2>
      <p className="mt-1 text-xs text-gray-600">{t("mix.session_only_hint")}</p>
      {myBoxes.length < 2 && (
        <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          {t("mix.need_more_boxes")}
        </p>
      )}
      {myBoxes.length >= 2 && (
        <form className="mt-3 space-y-3" onSubmit={(e) => void onSubmit(e)}>
          <div>
            <p className="text-sm font-medium">{t("mix.pick_label")}</p>
            <ul className="mt-2 space-y-1">
              {myBoxes.map((b) => {
                const ref = `${b.txId}#${b.outputIndex}`;
                const checked = selectedRefs.has(ref);
                return (
                  <li
                    key={ref}
                    className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(ref)}
                      id={`mix-pick-${ref}`}
                    />
                    <label
                      htmlFor={`mix-pick-${ref}`}
                      className="flex-1 cursor-pointer font-mono text-xs text-gray-700"
                    >
                      <span className="font-semibold">{b.label}</span>
                      <span className="ml-2 text-gray-500">
                        {b.txId.slice(0, 8)}…#{b.outputIndex}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
          <label className="flex flex-col text-sm">
            <span className="font-medium">{t("mix.n_label")}</span>
            <input
              type="number"
              min={2}
              max={Math.max(2, myBoxes.length)}
              value={nField}
              onChange={(e) => setNField(e.target.value)}
              className="mt-1 w-32 rounded border border-gray-300 px-2 py-1"
            />
            <span className="mt-1 text-xs text-gray-500">
              {t("mix.n_help", { picked: selectedBoxes.length, n })}
            </span>
          </label>
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="font-medium">{t("mix.fee_payer_label")}</legend>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="fee-payer"
                value="shard"
                checked={feePayer === "shard"}
                onChange={() => setFeePayer("shard")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{t("mix.fee_payer_shard")}</span>
                <span className="ml-2 text-xs text-gray-500">
                  {t("mix.fee_payer_shard_hint")}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="fee-payer"
                value="wallet"
                checked={feePayer === "wallet"}
                onChange={() => setFeePayer("wallet")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{t("mix.fee_payer_wallet")}</span>
                <span className="ml-2 text-xs text-amber-700">
                  {t("mix.fee_payer_wallet_hint")}
                </span>
              </span>
            </label>
          </fieldset>
          <button
            type="submit"
            disabled={submitting || !validN}
            className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {submitting ? t("mix.submitting") : t("mix.submit")}
          </button>
        </form>
      )}
      {success && (
        <p className="mt-3 break-all rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">
          {success}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
          {error}
        </p>
      )}
    </section>
  );
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/i, "").trim();
  if (cleaned.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
