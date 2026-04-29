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
import { useTranslation } from "react-i18next";

import { buildBulkDepositTx } from "@lovejoin/sdk";

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
    vaultBusy,
    vaultError,
    nextDepositIndex,
    rescan,
    unlockWithWallet,
  } = useAppState();
  const [rounds, setRounds] = useState<number>(30);
  const [count, setCount] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);

  // Reasonable upper bound: a deposit tx has 1 fee-shard input, N mix-box
  // outputs, 1 fee-shard output, plus mesh's wallet change — all ada-only.
  // 20 mix-boxes per tx fits comfortably within Cardano's 16 KB tx size
  // (each mix-box output is ~150 bytes for the address+value+inline datum).
  const MAX_BULK_COUNT = 20;

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
          <button
            type="button"
            className="lj-btn lj-btn--primary"
            disabled={!wallet || vaultBusy}
            onClick={() => void unlockWithWallet()}
          >
            {vaultBusy ? t("vault.unlocking") : t("vault.unlock_with_wallet")}
          </button>
        </div>
        {vaultError && (
          <div className="lj-banner lj-banner--coral mt-4">
            <span className="lj-banner__title">
              {t("vault.unlock_failed", { message: vaultError })}
            </span>
          </div>
        )}
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
      // Derive N owner secrets at consecutive HKDF indices so each new
      // mix-box has a distinct (a, b) and the vault rescan can find them
      // by sweeping the index range on next unlock.
      const ownerSecrets = Array.from({ length: count }, (_, i) =>
        deriveDepositSecret(vault.seed, nextDepositIndex + i).secret,
      );
      const result = await buildBulkDepositTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        rounds,
        ownerSecrets,
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
          <div className="grid gap-6 sm:grid-cols-2">
            <label className="lj-field">
              <span className="lj-field__label">{t("deposit.count_label")}</span>
              <input
                type="number"
                min={1}
                max={MAX_BULK_COUNT}
                value={count}
                onChange={(e) =>
                  setCount(
                    Math.min(
                      MAX_BULK_COUNT,
                      Math.max(1, Number.parseInt(e.target.value, 10) || 1),
                    ),
                  )
                }
                className="lj-input max-w-[10rem]"
              />
              <span className="lj-field__hint">
                {t("deposit.count_help", { denom: denomAda, total: formatAda(denomLovelace * BigInt(count)) })}
              </span>
            </label>

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
          </div>

          <div className="lj-banner lj-banner--signal">
            <span className="lj-eyebrow">{t("deposit.tx_preview_title")}</span>
            <span className="lj-banner__detail">
              {count > 1
                ? t("deposit.tx_preview_copy_bulk", {
                    count,
                    denom: denomAda,
                    total: formatAda(denomLovelace * BigInt(count)),
                  })
                : t("deposit.tx_preview_copy", { denom: denomAda })}
            </span>
          </div>

          <div>
            <button
              type="submit"
              disabled={submitting || rounds <= 0 || count <= 0}
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
