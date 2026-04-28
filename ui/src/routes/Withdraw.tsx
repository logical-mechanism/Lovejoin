// Withdraw — vault-driven owned-box picker + destination address.
//
// Spec: docs/spec/06-ui.md §"Withdraw" + M6.5 — "vault-backed primary
// flow (pick a live owned box + destination); ... one-click 'create a
// Seedelf destination' as a first-class option (delegates to Seedelf
// platform when configured); manual hex-paste path is gone in the
// production UI."

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  buildWithdrawTx,
  type MixBoxRef,
} from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { Hash } from "../components/ui/Hash.js";
import { SeedelfHint } from "../components/SeedelfHint.js";
import type { OwnedBox } from "../lib/vault.js";

export function Withdraw() {
  const { t } = useTranslation();
  const {
    config,
    provider,
    addresses,
    wallet,
    vault,
    ownedBoxes,
    rescan,
  } = useAppState();
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitTxId, setSubmitTxId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedRef !== null) return;
    if (ownedBoxes.length === 0) return;
    const first = ownedBoxes[0]!;
    setSelectedRef(`${first.entry.ref.txId}#${first.entry.ref.outputIndex}`);
  }, [ownedBoxes, selectedRef]);

  if (!provider || !addresses || !wallet || !vault || vault.seed.length === 0) {
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("withdraw.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("withdraw.section_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted">{t("withdraw.preconditions_missing")}</p>
      </section>
    );
  }

  const selected: OwnedBox | null =
    ownedBoxes.find(
      (b) => `${b.entry.ref.txId}#${b.entry.ref.outputIndex}` === selectedRef,
    ) ?? null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    setSubmitTxId(null);
    setSubmitError(null);
    try {
      const mixBox: MixBoxRef = {
        ref: selected.entry.ref,
        a: selected.entry.a,
        b: selected.entry.b,
      };
      const result = await buildWithdrawTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        ownerSecret: selected.secret,
        mixBox,
        destinationAddressBech32: destination.trim(),
        wallet,
        provider,
        addresses,
      });
      setSubmitTxId(result.txId);
      window.setTimeout(() => void rescan(), 12_000);
    } catch (err) {
      setSubmitError(t("withdraw.error", { message: (err as Error).message }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="lj-card">
      <header className="lj-card__head">
        <div>
          <Eyebrow>{t("withdraw.eyebrow")}</Eyebrow>
          <h2 className="lj-card__title">{t("withdraw.section_title")}</h2>
        </div>
      </header>
      <p className="text-sm text-muted leading-relaxed max-w-prose">
        {t("withdraw.lede")}
      </p>

      <form className="mt-8 space-y-6" onSubmit={(e) => void onSubmit(e)}>
        {ownedBoxes.length === 0 ? (
          <div className="lj-empty">
            <p className="lj-empty__title">{t("vault.empty")}</p>
            <p>{t("vault.empty_hint")}</p>
          </div>
        ) : (
          <fieldset className="space-y-2">
            <legend className="lj-field__label">
              {t("withdraw.select_a_box")}
            </legend>
            <ul className="flex flex-col divide-y divide-rule rounded-sm border border-rule">
              {ownedBoxes.map((box) => {
                const ref = `${box.entry.ref.txId}#${box.entry.ref.outputIndex}`;
                const ada = (Number(box.entry.utxo.lovelace) / 1_000_000).toFixed(2);
                const checked = ref === selectedRef;
                return (
                  <li key={ref}>
                    <label
                      className={`flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors ${checked ? "bg-rise" : "hover:bg-surface"}`}
                    >
                      <input
                        type="radio"
                        name="box-select"
                        checked={checked}
                        onChange={() => setSelectedRef(ref)}
                        className="accent-signal"
                      />
                      <span className="font-mono text-xs text-whisper w-8 text-right">
                        i={box.index}
                      </span>
                      <span className="flex-1 font-mono text-sm">
                        <Hash value={box.entry.ref.txId} edge={6} copyable={false} />
                        <span className="text-whisper">#{box.entry.ref.outputIndex}</span>
                      </span>
                      <span className="font-mono text-sm" data-num>
                        {ada} ₳
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}

        <label className="lj-field">
          <span className="lj-field__label">{t("withdraw.destination_label")}</span>
          <input
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("withdraw.destination_placeholder")}
            className="lj-input"
          />
          {destination.trim() && <SeedelfHint address={destination} />}
        </label>

        <div className="lj-banner lj-banner--signal">
          <span className="lj-eyebrow">{t("withdraw.tx_preview_title")}</span>
          <span className="lj-banner__detail">{t("withdraw.tx_preview_copy")}</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={submitting || !selected || !destination.trim()}
            className="lj-btn lj-btn--primary lj-btn--lg"
          >
            {submitting ? t("withdraw.submitting") : t("withdraw.submit")}
          </button>
          <a
            href="https://seedelfs.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="lj-btn"
          >
            {t("withdraw.create_seedelf")}
          </a>
        </div>
      </form>

      {!selected && ownedBoxes.length > 0 && (
        <p className="mt-4 text-xs text-whisper">{t("withdraw.no_box_selected")}</p>
      )}

      {submitTxId && (
        <div className="lj-banner lj-banner--signal mt-6">
          <span className="lj-banner__title">
            {t("withdraw.success", { txId: "" })}
          </span>
          <span className="lj-banner__detail">
            <Hash value={submitTxId} edge={8} />
          </span>
        </div>
      )}
      {submitError && (
        <div role="alert" className="lj-banner lj-banner--coral mt-6">
          <span className="lj-banner__title">{submitError}</span>
        </div>
      )}
    </section>
  );
}
