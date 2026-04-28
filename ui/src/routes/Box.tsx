// Box detail — single owned box, with the inline withdraw form.
//
// Spec: docs/spec/06-ui.md §"Box" — vault-detail view of one box. The
// owner secret is derived from the unlocked seed at the box's index;
// the user never types or pastes anything.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  buildWithdrawTx,
  type MixBoxRef,
} from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { Hash } from "../components/ui/Hash.js";
import { SeedelfHint } from "../components/SeedelfHint.js";

export function Box() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { txid, idx } = useParams<{ txid: string; idx: string }>();
  const {
    config,
    provider,
    addresses,
    wallet,
    vault,
    ownedBoxes,
    rescan,
  } = useAppState();
  const [destination, setDestination] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitTxId, setSubmitTxId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const outputIndex = idx !== undefined ? Number.parseInt(idx, 10) : NaN;
  const box = useMemo(
    () =>
      ownedBoxes.find(
        (b) =>
          b.entry.ref.txId === (txid ?? "").toLowerCase() &&
          b.entry.ref.outputIndex === outputIndex,
      ) ?? null,
    [ownedBoxes, txid, outputIndex],
  );

  useEffect(() => {
    if (!vault && txid) navigate("/vault");
  }, [vault, txid, navigate]);

  if (!vault) {
    return null;
  }

  if (!box) {
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("box.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("box.title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted">{t("box.not_found")}</p>
        <div className="mt-6">
          <Link to="/vault" className="lj-btn">
            {t("box.back_to_vault")}
          </Link>
        </div>
      </section>
    );
  }

  const ada = (Number(box.entry.utxo.lovelace) / 1_000_000).toFixed(2);

  const onWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider || !addresses || !wallet) return;
    setSubmitting(true);
    setSubmitTxId(null);
    setSubmitError(null);
    try {
      const mixBox: MixBoxRef = {
        ref: box.entry.ref,
        a: box.entry.a,
        b: box.entry.b,
      };
      const result = await buildWithdrawTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        ownerSecret: box.secret,
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
    <>
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("box.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("box.title")}</h2>
          </div>
          <div className="lj-stat">
            <span className="lj-stat__label">{t("common.amount")}</span>
            <span className="lj-stat__value" data-num>
              {ada} ₳
            </span>
          </div>
        </header>
        <dl className="grid grid-cols-1 gap-y-3 text-sm sm:grid-cols-2 sm:gap-x-12">
          <Row label="i" value={String(box.index)} />
          <Row
            label={t("box.deposit_tx")}
            valueNode={<Hash value={box.entry.ref.txId} edge={8} />}
          />
          <Row
            label="b"
            valueNode={<Hash value={hex(box.entry.b)} edge={6} copyable={false} />}
          />
          <Row
            label="a"
            valueNode={<Hash value={hex(box.entry.a)} edge={6} copyable={false} />}
          />
        </dl>
        <p className="mt-6 text-xs text-whisper leading-relaxed max-w-prose">
          {t("box.linkage_explainer")}
        </p>
      </section>

      {!provider || !addresses || !wallet ? (
        <section className="lj-card">
          <p className="text-sm text-muted">{t("box.preconditions_missing")}</p>
        </section>
      ) : (
        <section className="lj-card">
          <header className="lj-card__head">
            <div>
              <Eyebrow>{t("withdraw.eyebrow")}</Eyebrow>
              <h2 className="lj-card__title">{t("withdraw.section_title")}</h2>
            </div>
          </header>
          <form className="space-y-6" onSubmit={(e) => void onWithdraw(e)}>
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
              <span className="lj-banner__detail">
                {t("withdraw.tx_preview_copy")}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={submitting || !destination.trim()}
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
      )}
    </>
  );
}

function Row({
  label,
  value,
  valueNode,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-rule pb-3">
      <dt className="lj-eyebrow">{label}</dt>
      <dd className="font-mono text-paper">{valueNode ?? value}</dd>
    </div>
  );
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
