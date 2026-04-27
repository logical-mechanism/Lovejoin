// Deposit screen — "rounds" input + Deposit button.
//
// Drives the SDK's `buildDepositTx`: builds, signs, and submits a deposit
// tx. On success it lifts the resulting (a, b, x) + tx hash up to the App
// so the My Boxes list can show it and the Withdraw screen can spend it.
//
// All chain-touching work happens inside `buildDepositTx`. This component
// only owns the form state, the in-flight flag, and surfacing the result.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserWallet } from "@meshsdk/core";
import {
  buildDepositTx,
  type LovejoinAddresses,
  type BlockfrostProvider,
} from "@lovejoin/sdk";

import type { Network } from "../lib/sdk.js";

export interface DepositedBox {
  txId: string;
  outputIndex: 0;
  ownerSecretHex: string;
  aHex: string;
  bHex: string;
  label: string;
  rounds: number;
  createdAt: number;
}

export interface DepositPanelProps {
  network: Network;
  provider: BlockfrostProvider;
  addresses: LovejoinAddresses;
  wallet: BrowserWallet;
  onDeposited: (box: DepositedBox) => void;
}

export function DepositPanel({
  network,
  provider,
  addresses,
  wallet,
  onDeposited,
}: DepositPanelProps) {
  const { t } = useTranslation();
  const [rounds, setRounds] = useState<number>(30);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSuccess(null);
    setError(null);
    try {
      const result = await buildDepositTx({
        network: network as "preprod" | "preview" | "mainnet",
        rounds,
        wallet,
        provider,
        addresses,
      });
      onDeposited({
        txId: result.txId,
        outputIndex: 0,
        ownerSecretHex: result.owner.secretHex,
        // SDK now does deposit-time re-randomization: `a = [d]·g` for a
        // fresh per-deposit `d`, so we MUST store whatever `a` the SDK
        // chose (not the canonical generator). Withdraw uses this exact
        // (a, b) pair to reconstruct the inline datum.
        aHex: result.owner.aHex,
        bHex: result.owner.publicPointHex,
        label: result.owner.label,
        rounds,
        createdAt: Date.now(),
      });
      setSuccess(t("deposit.success", { txId: result.txId }));
    } catch (e) {
      setError(t("deposit.error", { message: (e as Error).message }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">{t("deposit.section_title")}</h2>
      <form className="mt-3 space-y-3" onSubmit={(e) => void onSubmit(e)}>
        <label className="flex flex-col text-sm">
          <span className="font-medium">{t("deposit.rounds_label")}</span>
          <input
            type="number"
            min={1}
            max={500}
            value={rounds}
            onChange={(e) => setRounds(Number.parseInt(e.target.value, 10) || 1)}
            className="mt-1 w-32 rounded border border-gray-300 px-2 py-1"
          />
          <span className="mt-1 text-xs text-gray-500">
            {t("deposit.rounds_help")}
          </span>
        </label>
        <button
          type="submit"
          disabled={submitting || rounds <= 0}
          className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {submitting ? t("deposit.submitting") : t("deposit.submit")}
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

