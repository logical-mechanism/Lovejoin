// Vault — wallet-derived owned-boxes view + lock + tier-2 BIP-39 fallback +
// inline (single + bulk) withdraw form.
//
// Spec: M6.5 — "wallet-derived vault (default flow) —
// zero new keys for the user to manage. On first 'unlock' the connected
// CIP-30 wallet does a single signData(stakeAddr, 'lovejoin/owner/v1');
// ... seed = blake2b_256(signature_bytes); per-deposit owner secret x_i =
// scalar_from_hkdf(seed, 'lovejoin/owner/v1', counter=i) reduced mod r.
// The seed is held in memory for the session only — IndexedDB stores
// nothing. Locking the vault drops the seed; unlocking re-prompts the
// wallet for one signature."
//
// The Withdraw screen used to live at `/withdraw` as a parallel flow with
// the same owned-box list, and the Vault row had a per-box "Withdraw"
// link to a single-box drill-in. Two screens with the same list confused
// users. We folded both single + bulk withdraw into Vault: a checkbox per
// row plus one destination input drives `buildBulkWithdrawTx` for any
// number of selected boxes (1..N). The Box detail route still exists for
// direct linking but isn't reachable from the table any more.
//
// External collateral via giveme.my so a fresh wallet can withdraw
// without holding a 5-ADA collateral UTxO of its own.
//
// The unlocked surface is split across three child components: the
// owned-boxes table (VaultTable), the withdraw form (WithdrawForm),
// and the per-row Mix confirm modal (MixReview). The Mix workflow
// itself lives in the `useMixThisBox` hook. This file orchestrates
// the shared selection state + page-level overlay.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { MixReview } from "../components/MixReview.js";
import { RecoverPasswordPanel } from "../components/RecoverPasswordPanel.js";
import { TxBuildProgress } from "../components/TxBuildProgress.js";
import { VaultTable } from "../components/VaultTable.js";
import { WithdrawForm } from "../components/WithdrawForm.js";
import { mixPhases, withdrawPhases } from "../lib/tx-phases.js";
import { useMixThisBox } from "../lib/use-mix-this-box.js";
import { useVisibleRefresh } from "../lib/use-visible-refresh.js";
import type { OwnedBox } from "../lib/vault.js";

export function Vault() {
  const { t } = useTranslation();
  const { wallet, vault, vaultBusy, vaultError, unlockWithWallet } = useAppState();
  const [showFallback, setShowFallback] = useState(false);

  if (!vault) {
    if (showFallback) {
      return <RecoverPasswordPanel onClose={() => setShowFallback(false)} />;
    }
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("vault.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("vault.locked_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted leading-relaxed max-w-prose">{t("vault.locked_lede")}</p>
        <div className="mt-6">
          <button
            type="button"
            className="lj-btn lj-btn--primary lj-btn--lg"
            disabled={!wallet || vaultBusy}
            onClick={() => void unlockWithWallet()}
          >
            {vaultBusy && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
            {vaultBusy ? t("vault.unlocking") : t("vault.unlock_with_wallet")}
          </button>
        </div>
        {!wallet && <p className="mt-4 text-sm text-whisper">{t("vault.no_wallet")}</p>}
        <div className="mt-6 border-t border-rule pt-4">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setShowFallback(true)}
            disabled={!wallet}
            title={!wallet ? t("vault.no_wallet") : undefined}
          >
            {t("vault.recover_link")}
            <span aria-hidden="true">→</span>
          </button>
        </div>
        {vaultError && (
          <div className="lj-banner lj-banner--coral mt-6">
            <span className="lj-banner__title">
              {t("vault.unlock_failed", { message: vaultError })}
            </span>
          </div>
        )}
      </section>
    );
  }

  return <UnlockedVault />;
}

function UnlockedVault() {
  const { t } = useTranslation();
  const {
    provider,
    addresses,
    vault,
    ownedBoxes,
    poolSize,
    scanError,
    lockVault,
    rescan,
    pendingTxRefs,
  } = useAppState();
  const { mixingRef, runMix, collateralOk, maxNShard } = useMixThisBox();

  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(() => new Set());
  const [confirmMixRef, setConfirmMixRef] = useState<string | null>(null);
  const [withdrawSubmitting, setWithdrawSubmitting] = useState(false);
  // Track rescan-in-flight locally so the "Scan again" button can
  // disable + show a spinner. The initial unlock-time scan is already
  // awaited inside `unlockWithWallet`, so by the time we render here
  // the box list is hydrated — no need to seed this `true`. The
  // useVisibleRefresh hook below silently fires `runRescan()` on tab
  // focus (after staleness) and on a 60 s timer while visible, so the
  // box list stays current without the user having to click anything;
  // when it does fire silently we still show the spinner so the user
  // sees that something refreshed.
  const [rescanning, setRescanning] = useState(false);
  const runRescan = async () => {
    if (rescanning) return;
    setRescanning(true);
    try {
      await rescan();
    } finally {
      setRescanning(false);
    }
  };
  // 60 s background refresh while visible. The deposit / withdraw /
  // mix flows all schedule their own 12 s rescan after submit, so this
  // is purely a "tab away for a while, come back to fresh data" tell —
  // not the primary mechanism for updating after a tx the user just
  // submitted themselves. `enabled` flips off the moment the vault
  // locks; useAppState's vault is null until unlock, and re-enables
  // once the user unlocks again.
  useVisibleRefresh(() => runRescan(), {
    intervalMs: 60_000,
    enabled: !!vault,
  });

  // Default-select the first owned box on initial load so single-box
  // users don't have to think about the new multi-select UI. Once the
  // user touches the checkboxes the auto-default doesn't reapply.
  // Skip pending boxes so we don't auto-select something already in
  // flight (the user can still see the row, dimmed, with the spinner).
  const [autoSelected, setAutoSelected] = useState(false);
  useEffect(() => {
    if (autoSelected) return;
    if (selectedRefs.size > 0) {
      setAutoSelected(true);
      return;
    }
    const first = ownedBoxes.find(
      (b) => !pendingTxRefs.has(`${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`),
    );
    if (!first) return;
    setSelectedRefs(
      new Set([`${first.entry.ref.txId.toLowerCase()}#${first.entry.ref.outputIndex}`]),
    );
    setAutoSelected(true);
  }, [ownedBoxes, selectedRefs, autoSelected, pendingTxRefs]);

  const toggleRef = (ref: string) => {
    if (pendingTxRefs.has(ref)) return; // can't toggle a pending row
    setSelectedRefs((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  };
  const clearAll = () => setSelectedRefs(new Set());
  const selectAll = () =>
    setSelectedRefs(
      new Set(
        ownedBoxes
          .map((b) => `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`)
          .filter((ref) => !pendingTxRefs.has(ref)),
      ),
    );

  const selectedBoxes: OwnedBox[] = useMemo(
    () =>
      ownedBoxes.filter((b) =>
        selectedRefs.has(`${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`),
      ),
    [ownedBoxes, selectedRefs],
  );

  const totalLovelace = useMemo(
    () => selectedBoxes.reduce((acc, b) => acc + b.entry.utxo.lovelace, 0n),
    [selectedBoxes],
  );

  const mixDisabled = !provider || !addresses || !collateralOk;
  const busy = withdrawSubmitting || mixingRef !== null;

  return (
    <section className={`lj-card lj-overlay ${busy ? "lj-overlay--busy" : ""}`}>
      <header className="lj-card__head">
        <div>
          <Eyebrow>
            {vault!.kind === "wallet" ? t("vault.eyebrow") : t("vault.eyebrow_recovery")}
          </Eyebrow>
          <h2 className="lj-card__title">{t("vault.title")}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => void runRescan()}
            disabled={withdrawSubmitting || rescanning}
          >
            {rescanning && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
            {rescanning ? t("vault.scanning_pool") : t("vault.scan_again")}
          </button>
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={lockVault}
            disabled={withdrawSubmitting}
          >
            {t("vault.lock")}
          </button>
        </div>
      </header>

      <p className="text-sm text-muted">
        {t("vault.scan_summary", { count: ownedBoxes.length, pool: poolSize })}
      </p>

      {scanError && (
        <div className="lj-banner lj-banner--coral mt-4">
          <span className="lj-banner__title">{t("vault.scan_failed", { message: scanError })}</span>
        </div>
      )}

      {ownedBoxes.length === 0 ? (
        <div className="lj-empty mt-8">
          <p className="lj-empty__title">{t("vault.empty")}</p>
          <p>{t("vault.empty_hint")}</p>
        </div>
      ) : (
        <div className="mt-6">
          <VaultTable
            boxes={ownedBoxes}
            pendingTxRefs={pendingTxRefs}
            selectedRefs={selectedRefs}
            selectedCount={selectedBoxes.length}
            selectedTotalLovelace={totalLovelace}
            onToggleRef={toggleRef}
            onSelectAll={selectAll}
            onClearAll={clearAll}
            mixingRef={mixingRef}
            mixDisabled={mixDisabled}
            {...(!collateralOk ? { mixDisabledTitle: t("vault.mix_disabled_collateral") } : {})}
            onRequestMix={(ref) => setConfirmMixRef(ref)}
            formSubmitting={withdrawSubmitting}
          />
          <WithdrawForm
            selectedBoxes={selectedBoxes}
            ownedBoxesCount={ownedBoxes.length}
            onSubmittingChange={setWithdrawSubmitting}
            onSubmitted={() => setSelectedRefs(new Set())}
          />
        </div>
      )}

      <div className="lj-overlay__indicator">
        <TxBuildProgress
          active={withdrawSubmitting}
          phases={withdrawPhases(t)}
          ariaLabel={t("withdraw.submitting")}
        />
        <TxBuildProgress
          active={mixingRef !== null}
          phases={mixPhases(t, maxNShard)}
          ariaLabel={t("vault.mix_row_submitting")}
        />
      </div>

      <MixReview
        open={confirmMixRef !== null}
        n={maxNShard}
        onClose={() => setConfirmMixRef(null)}
        onConfirm={() => {
          const ref = confirmMixRef;
          setConfirmMixRef(null);
          if (!ref) return;
          const target = ownedBoxes.find(
            (b) => `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}` === ref,
          );
          if (target) void runMix(target);
        }}
      />
    </section>
  );
}
