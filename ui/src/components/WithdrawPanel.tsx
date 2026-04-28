// Withdraw screen — pick a deposited box (or paste its details) +
// destination address, drive the SDK's `buildWithdrawTx`.
//
// The SDK does the two-pass build (placeholder Schnorr → real proof) and
// we just surface the resulting tx hash. The form pre-fills from a box
// the user clicked in the My Boxes list; manual paste is supported so the
// dev can withdraw a box deposited in a previous session if they kept the
// secret somewhere safe.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserWallet } from "@meshsdk/core";
import {
  buildWithdrawTx,
  type LovejoinAddresses,
  type BlockfrostProvider,
  type MixBoxRef,
} from "@lovejoin/sdk";

import type { Network } from "../lib/sdk.js";
import { SeedelfHint } from "./SeedelfHint.js";
import type { DepositedBox } from "./DepositPanel.js";

export interface WithdrawPanelProps {
  network: Network;
  provider: BlockfrostProvider;
  addresses: LovejoinAddresses;
  wallet: BrowserWallet;
  prefill: DepositedBox | null;
  onWithdrawn: (box: DepositedBox) => void;
}

export function WithdrawPanel({
  network,
  provider,
  addresses,
  wallet,
  prefill,
  onWithdrawn,
}: WithdrawPanelProps) {
  const { t } = useTranslation();
  const [secretHex, setSecretHex] = useState("");
  const [boxRef, setBoxRef] = useState("");
  const [aHex, setAHex] = useState("");
  const [bHex, setBHex] = useState("");
  const [destination, setDestination] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (prefill) {
      setSecretHex(prefill.ownerSecretHex);
      setBoxRef(`${prefill.txId}#${prefill.outputIndex}`);
      setAHex(prefill.aHex);
      setBHex(prefill.bHex);
      setSuccess(null);
      setError(null);
    }
  }, [prefill]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSuccess(null);
    setError(null);
    try {
      const [txId, idxStr] = boxRef.split("#");
      if (!txId || idxStr === undefined) {
        throw new Error("box ref must be <txId>#<index>");
      }
      const outputIndex = Number.parseInt(idxStr, 10);
      if (!Number.isInteger(outputIndex) || outputIndex < 0) {
        throw new Error("box ref index must be a non-negative integer");
      }
      const ownerSecret = BigInt(`0x${secretHex.replace(/^0x/i, "")}`);
      const mixBox: MixBoxRef = {
        ref: { txId: txId.toLowerCase(), outputIndex },
        a: hexToBytes(aHex),
        b: hexToBytes(bHex),
      };
      const result = await buildWithdrawTx({
        network: network as "preprod" | "preview" | "mainnet",
        ownerSecret,
        mixBox,
        destinationAddressBech32: destination.trim(),
        wallet,
        provider,
        addresses,
      });
      setSuccess(t("withdraw.success", { txId: result.txId }));
      // We surface the spent box upward so the parent can drop it from
      // the my-boxes list (a withdrawn box can't be spent again).
      if (prefill) onWithdrawn(prefill);
    } catch (e) {
      setError(t("withdraw.error", { message: (e as Error).message }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">{t("withdraw.section_title")}</h2>
      <p className="mt-1 text-xs text-gray-600">
        {prefill
          ? t("withdraw.from_my_boxes", { label: prefill.label })
          : t("withdraw.select_a_box")}
      </p>
      <form className="mt-3 space-y-3" onSubmit={(e) => void onSubmit(e)}>
        <Field
          label={t("withdraw.secret_label")}
          value={secretHex}
          onChange={setSecretHex}
          mono
          placeholder="64-char hex"
        />
        <Field
          label={t("withdraw.box_ref_label")}
          value={boxRef}
          onChange={setBoxRef}
          mono
          placeholder="<64-hex-txid>#<index>"
        />
        <Field
          label={t("withdraw.box_a_label")}
          value={aHex}
          onChange={setAHex}
          mono
          placeholder="96-char hex"
        />
        <Field
          label={t("withdraw.box_b_label")}
          value={bHex}
          onChange={setBHex}
          mono
          placeholder="96-char hex"
        />
        <Field
          label={t("withdraw.destination_label")}
          value={destination}
          onChange={setDestination}
          placeholder="addr_test1..."
        />
        {destination.trim() && <SeedelfHint address={destination} />}
        <button
          type="submit"
          disabled={
            submitting ||
            !secretHex ||
            !boxRef ||
            !aHex ||
            !bHex ||
            !destination
          }
          className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {submitting ? t("withdraw.submitting") : t("withdraw.submit")}
        </button>
      </form>
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

function Field({
  label,
  value,
  onChange,
  mono,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col text-sm">
      <span className="font-medium">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        className={`mt-1 rounded border border-gray-300 px-2 py-1 ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
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
