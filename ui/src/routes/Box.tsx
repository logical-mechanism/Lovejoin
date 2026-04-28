// Box detail — single owned box, with the inline withdraw form.
//
// Spec: docs/spec/06-ui.md §"Box" — generation count + parent transactions
// (deferred — needs M5 history endpoint), withdraw form, estimated linkage
// probability + explainer text, SeedelfHint when destination is a regular
// Cardano address.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";

import { PassphraseModal } from "../components/PassphraseModal.js";
import { WithdrawPanel } from "../components/WithdrawPanel.js";
import { useAppState } from "../lib/store.js";

export function Box() {
  const { t } = useTranslation();
  const { txid, idx } = useParams<{ txid: string; idx: string }>();
  const {
    config,
    provider,
    addresses,
    wallet,
    vault,
    boxes,
    removeBox,
  } = useAppState();

  const outputIndex = idx !== undefined ? Number.parseInt(idx, 10) : NaN;
  const box = useMemo(
    () =>
      boxes.find(
        (b) =>
          b.txId === (txid ?? "").toLowerCase() && b.outputIndex === outputIndex,
      ) ?? null,
    [boxes, txid, outputIndex],
  );

  if (!vault) {
    return <PassphraseModal />;
  }

  if (!box) {
    return (
      <section className="rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-700">
        <p>{t("box.not_found")}</p>
        <p className="mt-2">
          <Link className="underline" to="/vault">
            {t("box.back_to_vault")}
          </Link>
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="text-lg font-semibold">{t("box.title")}</h2>
        <dl className="mt-3 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
          <Row label={t("box.label_field")} value={box.label} />
          <Row label={t("box.deposit_tx")} value={`${box.txId}#${box.outputIndex}`} />
          <Row
            label={t("box.deposited_at")}
            value={new Date(box.createdAt).toISOString()}
          />
          <Row label={t("box.intended_rounds")} value={String(box.rounds)} />
        </dl>
        <p className="mt-3 text-xs text-gray-600">{t("box.linkage_explainer")}</p>
      </section>

      {provider && addresses && wallet && (
        <WithdrawPanel
          network={config.network}
          provider={provider}
          addresses={addresses}
          wallet={wallet}
          prefill={{
            txId: box.txId,
            outputIndex: box.outputIndex as 0,
            ownerSecretHex: box.ownerSecretHex,
            aHex: box.aHex,
            bHex: box.bHex,
            label: box.label,
            rounds: box.rounds,
            createdAt: box.createdAt,
          }}
          onWithdrawn={(spent) => {
            void removeBox(spent.txId, spent.outputIndex);
          }}
        />
      )}
      {(!provider || !addresses || !wallet) && (
        <p className="text-sm text-gray-600">
          {t("box.preconditions_missing")}
        </p>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
      <dt className="font-medium text-gray-700">{label}:</dt>
      <dd className="break-all font-mono text-gray-700">{value}</dd>
    </div>
  );
}
