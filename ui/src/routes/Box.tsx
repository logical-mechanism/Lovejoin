// Box detail / withdraw — single owned box, with the inline withdraw form.
//
// Spec: docs/spec/06-ui.md §"Box" + M6.5 dogfood feedback. The vault row's
// primary action lands here pre-pointed at the withdraw form. The
// SeedelfHint stays (passive copy when the destination is a key
// address), but the "create a Seedelf" CTA is gone — Seedelf integration
// is its own milestone, premature to surface here.
//
// Withdraw collateral is supplied by the configured external provider
// (giveme.my by default). The wallet still signs the tx (it pays the
// fee and receives the change), but it doesn't need a 5-ADA collateral
// UTxO of its own — the user can withdraw from a freshly-funded wallet
// that only holds enough ADA to cover the tx fee.
//
// On success: toast (with cardanoscan link), navigate back to /vault,
// schedule a rescan so the box disappears as soon as the tx confirms.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  GivemeMyProvider,
  buildWithdrawTx,
  type MixBoxRef,
} from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { Hash } from "../components/ui/Hash.js";
import { SeedelfHint } from "../components/SeedelfHint.js";
import { useToast } from "../components/Toaster.js";

export function Box() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { txid, idx } = useParams<{ txid: string; idx: string }>();
  const toast = useToast();
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
    if (!provider || !addresses || !wallet || submitting) return;
    setSubmitting(true);
    try {
      const mixBox: MixBoxRef = {
        ref: box.entry.ref,
        a: box.entry.a,
        b: box.entry.b,
      };
      // External collateral via giveme.my so a fresh wallet without a
      // 5-ADA collateral UTxO can still withdraw. Same endpoint Mix
      // already uses; toggling between the two providers stays cheap.
      const collateralProvider = new GivemeMyProvider({
        endpoint: config.collateralProviderEndpoint,
        network: config.network,
      });
      const result = await buildWithdrawTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        ownerSecret: box.secret,
        mixBox,
        destinationAddressBech32: destination.trim(),
        wallet,
        provider,
        addresses,
        collateralProvider,
      });
      toast.push({
        tone: "success",
        title: t("toast.withdraw_success"),
        txHash: result.txId,
        network: config.network,
      });
      // Schedule a rescan so the row drops once the chain confirms; in
      // the meantime navigate back so the user isn't stuck on a stale
      // detail page.
      window.setTimeout(() => void rescan(), 12_000);
      navigate("/vault");
    } catch (err) {
      toast.push({
        tone: "error",
        title: t("toast.withdraw_failed"),
        detail: (err as Error).message,
      });
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
        <section className={`lj-card lj-overlay ${submitting ? "lj-overlay--busy" : ""}`}>
          <header className="lj-card__head">
            <div>
              <Eyebrow>{t("withdraw.eyebrow")}</Eyebrow>
              <h2 className="lj-card__title">{t("withdraw.section_title")}</h2>
            </div>
            <Link to="/vault" className="lj-btn lj-btn--quiet">
              ← {t("box.back_to_vault")}
            </Link>
          </header>
          <form
            className="space-y-6"
            onSubmit={(e) => void onWithdraw(e)}
            aria-busy={submitting}
          >
            <fieldset disabled={submitting} className="space-y-6 contents">
              <label className="lj-field">
                <span className="lj-field__label">
                  {t("withdraw.destination_label")}
                </span>
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

              <div>
                <button
                  type="submit"
                  disabled={submitting || !destination.trim()}
                  className="lj-btn lj-btn--primary lj-btn--lg"
                >
                  {submitting ? t("withdraw.submitting") : t("withdraw.submit")}
                </button>
              </div>
            </fieldset>
          </form>
          {submitting && (
            <div className="lj-overlay__indicator">
              <div className="lj-spinner" aria-label={t("withdraw.submitting")} />
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
