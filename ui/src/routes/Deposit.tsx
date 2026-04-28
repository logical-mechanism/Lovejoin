// Deposit — single form, vault-derived owner secret.
//
// Spec: docs/spec/06-ui.md §"Deposit" + M6.5 vault rework. The owner
// secret is derived from the unlocked seed at the next available index;
// on success we toast (with a cardanoscan link) and trigger a rescan
// so the new box surfaces in the Vault screen within a few seconds.
//
// The deposit-time `(a, b)` are owned by the SDK (`buildDepositTx` picks
// a fresh `d` and computes `a = [d]·G`, `b = [x·d]·G`). The UI doesn't
// persist them — `findOwnedBoxes` re-derives ownership on every unlock.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { buildDepositTx } from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { useToast } from "../components/Toaster.js";
import { deriveDepositSecret } from "../lib/vault.js";
import { formatAda } from "../lib/format.js";

export function Deposit() {
  const { t } = useTranslation();
  const toast = useToast();
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
  const denomAda = formatAda(denomLovelace);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
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
      toast.push({
        tone: "success",
        title: t("toast.deposit_success"),
        txHash: result.txId,
        network: config.network,
      });
      window.setTimeout(() => void rescan(), 12_000);
    } catch (err) {
      toast.push({
        tone: "error",
        title: t("toast.deposit_failed"),
        detail: (err as Error).message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className={`lj-card lj-overlay ${submitting ? "lj-overlay--busy" : ""}`}>
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
        className="mt-6 flex flex-col gap-6"
        onSubmit={(e) => void onSubmit(e)}
        aria-busy={submitting}
      >
        <fieldset disabled={submitting} className="contents">
          <label className="lj-field max-w-xs">
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

          <div className="lj-banner lj-banner--signal">
            <span className="lj-eyebrow">{t("deposit.tx_preview_title")}</span>
            <span className="lj-banner__detail">
              {t("deposit.tx_preview_copy", { denom: denomAda })}
            </span>
          </div>

          <div>
            <button
              type="submit"
              disabled={submitting || rounds <= 0}
              className="lj-btn lj-btn--primary lj-btn--lg"
            >
              {submitting ? t("deposit.submitting") : t("deposit.submit")}
            </button>
          </div>
        </fieldset>
      </form>

      {submitting && (
        <div className="lj-overlay__indicator">
          <div className="lj-spinner" aria-label={t("deposit.submitting")} />
        </div>
      )}
    </section>
  );
}
