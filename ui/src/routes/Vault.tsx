// Vault — wallet-derived owned-boxes view + lock + tier-2 BIP-39 fallback +
// inline (single + bulk) withdraw form.
//
// Spec: docs/spec/06-ui.md M6.5 — "wallet-derived vault (default flow) —
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

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GivemeMyProvider,
  buildBulkWithdrawTx,
  type BulkWithdrawEntry,
} from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { Hash } from "../components/ui/Hash.js";
import { StatusDot } from "../components/ui/StatusDot.js";
import { Bip39FallbackPanel } from "../components/Bip39FallbackPanel.js";
import { useToast } from "../components/Toaster.js";
import { WithdrawReview } from "../components/WithdrawReview.js";
import { formatAda } from "../lib/format.js";
import { validateDestination } from "../lib/seedelf.js";
import type { OwnedBox } from "../lib/vault.js";

export function Vault() {
  const { t } = useTranslation();
  const { wallet, vault, vaultBusy, vaultError, unlockWithWallet } =
    useAppState();
  const [showFallback, setShowFallback] = useState(false);

  if (!vault) {
    if (showFallback) {
      return (
        <Bip39FallbackPanel onClose={() => setShowFallback(false)} />
      );
    }
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("vault.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("vault.locked_title")}</h2>
          </div>
          <StatusDot tone="neutral" hollow label="locked" />
        </header>
        <p className="text-sm text-muted leading-relaxed max-w-prose">
          {t("vault.locked_lede")}
        </p>
        <div className="mt-6">
          <button
            type="button"
            className="lj-btn lj-btn--primary lj-btn--lg"
            disabled={!wallet || vaultBusy}
            onClick={() => void unlockWithWallet()}
          >
            {vaultBusy ? t("vault.unlocking") : t("vault.unlock_with_wallet")}
          </button>
        </div>
        {!wallet && (
          <p className="mt-4 text-sm text-whisper">{t("vault.no_wallet")}</p>
        )}
        <div className="mt-6 border-t border-rule pt-4">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setShowFallback(true)}
          >
            {t("vault.fallback_link")}
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
  const toast = useToast();
  const {
    config,
    provider,
    addresses,
    wallet,
    vault,
    ownedBoxes,
    poolSize,
    scanError,
    lockVault,
    rescan,
  } = useAppState();

  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(() => new Set());
  const [destination, setDestination] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Default-select the first owned box on initial load so single-box
  // users don't have to think about the new multi-select UI. Once the
  // user touches the checkboxes the auto-default doesn't reapply.
  const [autoSelected, setAutoSelected] = useState(false);
  useEffect(() => {
    if (autoSelected) return;
    if (selectedRefs.size > 0) {
      setAutoSelected(true);
      return;
    }
    if (ownedBoxes.length === 0) return;
    const first = ownedBoxes[0]!;
    setSelectedRefs(new Set([`${first.entry.ref.txId}#${first.entry.ref.outputIndex}`]));
    setAutoSelected(true);
  }, [ownedBoxes, selectedRefs, autoSelected]);

  const toggleRef = (ref: string) => {
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
        ownedBoxes.map((b) => `${b.entry.ref.txId}#${b.entry.ref.outputIndex}`),
      ),
    );

  const selectedBoxes: OwnedBox[] = useMemo(
    () =>
      ownedBoxes.filter((b) =>
        selectedRefs.has(`${b.entry.ref.txId}#${b.entry.ref.outputIndex}`),
      ),
    [ownedBoxes, selectedRefs],
  );

  const totalLovelace = useMemo(
    () => selectedBoxes.reduce((acc, b) => acc + b.entry.utxo.lovelace, 0n),
    [selectedBoxes],
  );

  const validation = useMemo(
    () => validateDestination(destination, config.network),
    [destination, config.network],
  );

  const preconditionsOk = !!provider && !!addresses && !!wallet && !!vault;
  const canSubmit =
    preconditionsOk &&
    selectedBoxes.length > 0 &&
    validation.status === "ok" &&
    !submitting;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preconditionsOk || selectedBoxes.length === 0 || submitting) return;
    if (validation.status !== "ok") return;
    setSubmitting(true);
    try {
      const entries: BulkWithdrawEntry[] = selectedBoxes.map((b) => ({
        mixBox: { ref: b.entry.ref, a: b.entry.a, b: b.entry.b },
        ownerSecret: b.secret,
      }));
      // Empty config endpoint = let the SDK use its pinned host URL.
      const collateralProvider = new GivemeMyProvider({
        network: config.network,
        ...(config.collateralProviderEndpoint
          ? { endpoint: config.collateralProviderEndpoint }
          : {}),
      });
      const result = await buildBulkWithdrawTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        entries,
        destinationAddressBech32: destination.trim(),
        wallet: wallet!,
        provider: provider!,
        addresses: addresses!,
        collateralProvider,
      });
      toast.push({
        tone: "success",
        title: t("toast.withdraw_success"),
        txHash: result.txId,
        network: config.network,
      });
      // Clear the picker so the row visibly drains as the chain confirms;
      // schedule a rescan so the boxes drop out of `ownedBoxes` once the
      // withdraw tx lands on chain.
      setSelectedRefs(new Set());
      setDestination("");
      window.setTimeout(() => void rescan(), 12_000);
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
    <section className={`lj-card lj-overlay ${submitting ? "lj-overlay--busy" : ""}`}>
      <header className="lj-card__head">
        <div>
          <Eyebrow>
            {vault!.kind === "wallet"
              ? t("vault.eyebrow")
              : t("vault.fallback_title")}
          </Eyebrow>
          <h2 className="lj-card__title">{t("vault.title")}</h2>
        </div>
        <div className="flex items-center gap-2">
          <StatusDot tone="ok" label="unlocked" />
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => void rescan()}
            disabled={submitting}
          >
            {t("vault.scan_again")}
          </button>
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={lockVault}
            disabled={submitting}
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
          <span className="lj-banner__title">
            {t("vault.scan_failed", { message: scanError })}
          </span>
        </div>
      )}

      {ownedBoxes.length === 0 ? (
        <div className="lj-empty mt-8">
          <p className="lj-empty__title">{t("vault.empty")}</p>
          <p>{t("vault.empty_hint")}</p>
        </div>
      ) : (
        <form
          className="mt-6 space-y-6"
          onSubmit={(e) => void onSubmit(e)}
          aria-busy={submitting}
        >
          <fieldset disabled={submitting} className="contents">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="lj-field__label">
                  {t("withdraw.select_boxes")}
                </span>
                <div className="flex gap-3 text-xs">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-muted underline-offset-2 hover:underline disabled:opacity-50"
                    disabled={selectedBoxes.length === ownedBoxes.length}
                  >
                    {t("withdraw.select_all")}
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="text-muted underline-offset-2 hover:underline disabled:opacity-50"
                    disabled={selectedBoxes.length === 0}
                  >
                    {t("withdraw.clear_selection")}
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="lj-table">
                  <thead>
                    <tr>
                      <th className="w-8" />
                      <th>i</th>
                      <th>{t("common.tx_hash")}</th>
                      <th className="lj-table__num">b</th>
                      <th className="lj-table__num">{t("common.amount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ownedBoxes.map((box) => {
                      const ref = `${box.entry.ref.txId}#${box.entry.ref.outputIndex}`;
                      const ada = formatAda(box.entry.utxo.lovelace);
                      const checked = selectedRefs.has(ref);
                      return (
                        <tr
                          key={ref}
                          className={`cursor-pointer ${checked ? "bg-rise" : ""}`}
                          onClick={() => toggleRef(ref)}
                        >
                          <td className="text-center">
                            <input
                              type="checkbox"
                              name="box-select"
                              checked={checked}
                              onChange={() => toggleRef(ref)}
                              onClick={(e) => e.stopPropagation()}
                              className="accent-paper"
                              aria-label={t("withdraw.select_boxes")}
                            />
                          </td>
                          <td className="lj-table__num">{box.index}</td>
                          <td>
                            <Hash value={box.entry.ref.txId} edge={6} />
                            <span className="text-whisper text-xs">
                              #{box.entry.ref.outputIndex}
                            </span>
                          </td>
                          <td className="lj-table__num">
                            <Hash
                              value={bytesToHexShort(box.entry.b)}
                              edge={4}
                              copyable={false}
                            />
                          </td>
                          <td className="lj-table__num">{ada} ₳</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {selectedBoxes.length > 0 && (
                <p className="text-xs text-muted">
                  {t("withdraw.selection_summary", {
                    count: selectedBoxes.length,
                    total: formatAda(totalLovelace),
                  })}
                </p>
              )}
            </div>

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
                className={`lj-input${
                  validation.status === "invalid" ||
                  validation.status === "wrong-network"
                    ? " lj-input--error"
                    : ""
                }`}
                aria-invalid={
                  validation.status === "invalid" ||
                  validation.status === "wrong-network"
                }
              />
              {validation.status === "invalid" && (
                <p className="lj-field__error" role="alert">
                  {t("withdraw.dest_invalid")}
                </p>
              )}
              {validation.status === "wrong-network" && (
                <p className="lj-field__warn" role="alert">
                  {t("withdraw.dest_wrong_network", {
                    addressNet:
                      validation.addressNetwork === "testnet"
                        ? t("withdraw.net_testnet")
                        : t("withdraw.net_mainnet"),
                    expected: config.network,
                  })}
                </p>
              )}
              {validation.status === "ok" &&
                validation.kind.kind === "regular-key" && (
                  <p className="lj-field__hint">
                    {t("withdraw.dest_regular_key")}
                  </p>
                )}
              {validation.status === "ok" &&
                validation.kind.kind === "stealth" && (
                  <p className="lj-field__hint">
                    {t("withdraw.dest_stealth")}
                  </p>
                )}
            </label>

            {selectedBoxes.length > 0 && (
              <WithdrawReview
                lovelace={totalLovelace}
                destination={destination}
                validation={validation}
              />
            )}

            <div className="lj-banner lj-banner--signal">
              <span className="lj-eyebrow">{t("withdraw.tx_preview_title")}</span>
              <span className="lj-banner__detail">
                {t("withdraw.tx_preview_copy")}
              </span>
            </div>

            <div>
              <button
                type="submit"
                disabled={!canSubmit}
                className="lj-btn lj-btn--primary lj-btn--lg"
              >
                {submitting ? t("withdraw.submitting") : t("withdraw.submit")}
              </button>
              {!preconditionsOk && (
                <p className="mt-3 text-sm text-muted">
                  {t("withdraw.preconditions_missing")}
                </p>
              )}
              {preconditionsOk &&
                selectedBoxes.length === 0 &&
                ownedBoxes.length > 0 &&
                !submitting && (
                  <p className="mt-3 text-xs text-whisper">
                    {t("withdraw.no_box_selected")}
                  </p>
                )}
            </div>
          </fieldset>
        </form>
      )}

      {submitting && (
        <div className="lj-overlay__indicator">
          <div className="lj-spinner" aria-label={t("withdraw.submitting")} />
        </div>
      )}
    </section>
  );
}

function bytesToHexShort(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
