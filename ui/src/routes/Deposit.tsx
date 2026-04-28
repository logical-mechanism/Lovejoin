// Deposit — single form, vault-derived owner secret.
//
// Spec: docs/spec/06-ui.md §"Deposit" + M6.5 vault rework. The owner
// secret is derived from the unlocked seed at the next available index
// (`nextDepositIndex`); on success we trigger a vault rescan so the new
// box surfaces in the Vault screen within a few seconds.
//
// The deposit-time `(a, b)` are owned by the SDK (`buildDepositTx` picks
// a fresh `d` and computes `a = [d]·G`, `b = [x·d]·G`). The UI doesn't
// persist them — `findOwnedBoxes` re-derives ownership on every unlock.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { buildDepositTx } from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { Hash } from "../components/ui/Hash.js";
import { deriveDepositSecret } from "../lib/vault.js";

export function Deposit() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    config,
    provider,
    addresses,
    wallet,
    vault,
    nextDepositIndex,
    rescan,
  } = useAppState();
  const [rounds, setRounds] = useState<number>(30);
  const [submitting, setSubmitting] = useState(false);
  const [submitTxId, setSubmitTxId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (!provider || !addresses || !wallet) {
    return (
      <section className="lj-card">
        <p className="text-sm text-muted">{t("deposit.preconditions_missing")}</p>
      </section>
    );
  }

  if (!vault || vault.seed.length === 0) {
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("deposit.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("deposit.section_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted">{t("deposit.preconditions_missing")}</p>
        <div className="mt-6">
          <Link to="/vault" className="lj-btn lj-btn--primary">
            {t("vault.unlock_with_wallet")}
          </Link>
        </div>
      </section>
    );
  }

  const denomLovelace = BigInt(addresses.protocol.denom_lovelace);
  const denomAda = (Number(denomLovelace) / 1_000_000).toFixed(2);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitTxId(null);
    setSubmitError(null);
    try {
      const { secret } = deriveDepositSecret(vault.seed, nextDepositIndex);
      const result = await buildDepositTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        rounds,
        ownerSecret: secret,
        wallet,
        provider,
        addresses,
      });
      setSubmitTxId(result.txId);
      // Schedule a rescan so the Vault screen picks up the new box once
      // the chain confirms it. Rescan is cheap; safe to call repeatedly.
      window.setTimeout(() => void rescan(), 12_000);
    } catch (err) {
      setSubmitError(t("deposit.error", { message: (err as Error).message }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="lj-card">
      <header className="lj-card__head">
        <div>
          <Eyebrow>{t("deposit.eyebrow")}</Eyebrow>
          <h2 className="lj-card__title">{t("deposit.section_title")}</h2>
        </div>
        <div className="lj-stat">
          <span className="lj-stat__label">{t("common.amount")}</span>
          <span className="lj-stat__value" data-num>
            {denomAda} ₳
          </span>
        </div>
      </header>
      <p className="text-sm text-muted leading-relaxed max-w-prose">
        {t("deposit.lede")}
      </p>

      <form
        className="mt-8 grid gap-6 md:grid-cols-2"
        onSubmit={(e) => void onSubmit(e)}
      >
        <label className="lj-field">
          <span className="lj-field__label">{t("deposit.rounds_label")}</span>
          <input
            type="number"
            min={1}
            max={500}
            value={rounds}
            onChange={(e) => setRounds(Number.parseInt(e.target.value, 10) || 1)}
            className="lj-input max-w-[10rem]"
          />
          <span className="lj-field__hint">{t("deposit.rounds_help")}</span>
        </label>

        <div className="flex flex-col gap-2">
          <span className="lj-field__label">i</span>
          <span className="font-display text-3xl font-light text-paper" data-num>
            {nextDepositIndex}
          </span>
          <span className="lj-field__hint">{t("deposit.index_help")}</span>
        </div>

        <div className="md:col-span-2">
          <div className="lj-banner lj-banner--signal">
            <span className="lj-eyebrow">{t("deposit.tx_preview_title")}</span>
            <span className="lj-banner__detail">
              {t("deposit.tx_preview_copy", { denom: denomAda })}
            </span>
          </div>
        </div>

        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={submitting || rounds <= 0}
            className="lj-btn lj-btn--primary lj-btn--lg"
          >
            {submitting ? t("deposit.submitting") : t("deposit.submit")}
          </button>
        </div>
      </form>

      {submitTxId && (
        <div className="lj-banner lj-banner--signal mt-6">
          <span className="lj-banner__title">
            {t("deposit.success", { txId: "" })}
          </span>
          <span className="lj-banner__detail">
            <Hash value={submitTxId} edge={8} />
          </span>
          <span className="mt-2 text-xs text-muted">
            {t("deposit.see_vault")}{" "}
            <button
              type="button"
              onClick={() => navigate("/vault")}
              className="underline"
            >
              {t("nav.vault")}
            </button>
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
