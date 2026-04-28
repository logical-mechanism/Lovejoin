// Withdraw — vault-driven owned-box picker + destination address.
//
// Spec: docs/spec/06-ui.md §"Withdraw" + M6.5 dogfood feedback. Drops the
// Seedelf-create CTA (premature; Seedelf integration is its own
// milestone) and the manual hex-paste form. External collateral via
// giveme.my so a fresh wallet can withdraw without holding a 5-ADA
// collateral UTxO.
//
// Outcome surfacing: toast (top-right slide-in) on success/failure with
// a cardanoscan link for the success path. The form goes into a busy
// overlay while the tx builder is running so users have unambiguous
// feedback that their click registered.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  GivemeMyProvider,
  buildBulkWithdrawTx,
  type BulkWithdrawEntry,
} from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { Hash } from "../components/ui/Hash.js";
import { useToast } from "../components/Toaster.js";
import { WithdrawReview } from "../components/WithdrawReview.js";
import { formatAda } from "../lib/format.js";
import { validateDestination } from "../lib/seedelf.js";
import type { OwnedBox } from "../lib/vault.js";

export function Withdraw() {
  const { t } = useTranslation();
  const navigate = useNavigate();
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

  const selectedBoxes: OwnedBox[] = useMemo(
    () =>
      ownedBoxes.filter((b) =>
        selectedRefs.has(`${b.entry.ref.txId}#${b.entry.ref.outputIndex}`),
      ),
    [ownedBoxes, selectedRefs],
  );

  const totalLovelace = useMemo(
    () =>
      selectedBoxes.reduce(
        (acc, b) => acc + b.entry.utxo.lovelace,
        0n,
      ),
    [selectedBoxes],
  );

  const validation = useMemo(
    () => validateDestination(destination, config.network),
    [destination, config.network],
  );
  const canSubmit =
    selectedBoxes.length > 0 && validation.status === "ok" && !submitting;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedBoxes.length === 0 || submitting) return;
    if (validation.status !== "ok") return;
    setSubmitting(true);
    try {
      const entries: BulkWithdrawEntry[] = selectedBoxes.map((b) => ({
        mixBox: {
          ref: b.entry.ref,
          a: b.entry.a,
          b: b.entry.b,
        },
        ownerSecret: b.secret,
      }));
      const collateralProvider = new GivemeMyProvider({
        endpoint: config.collateralProviderEndpoint,
        network: config.network,
      });
      const result = await buildBulkWithdrawTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        entries,
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
    <section className={`lj-card lj-overlay ${submitting ? "lj-overlay--busy" : ""}`}>
      <header className="lj-card__head">
        <div>
          <Eyebrow>{t("withdraw.eyebrow")}</Eyebrow>
          <h2 className="lj-card__title">{t("withdraw.section_title")}</h2>
        </div>
      </header>
      <p className="text-sm text-muted leading-relaxed max-w-prose">
        {t("withdraw.lede")}
      </p>

      <form
        className="mt-6 space-y-6"
        onSubmit={(e) => void onSubmit(e)}
        aria-busy={submitting}
      >
        <fieldset disabled={submitting} className="contents">
          {ownedBoxes.length === 0 ? (
            <div className="lj-empty">
              <p className="lj-empty__title">{t("withdraw.empty_title")}</p>
              <p>{t("withdraw.empty_hint")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="lj-field__label">{t("withdraw.select_boxes")}</span>
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
              <ul className="flex flex-col divide-y divide-rule rounded-sm border border-rule">
                {ownedBoxes.map((box) => {
                  const ref = `${box.entry.ref.txId}#${box.entry.ref.outputIndex}`;
                  const ada = formatAda(box.entry.utxo.lovelace);
                  const checked = selectedRefs.has(ref);
                  return (
                    <li key={ref}>
                      <label
                        className={`flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors ${checked ? "bg-rise" : "hover:bg-surface"}`}
                      >
                        <input
                          type="checkbox"
                          name="box-select"
                          checked={checked}
                          onChange={() => toggleRef(ref)}
                          className="accent-paper"
                        />
                        <span className="font-mono text-xs text-whisper w-8 text-right">
                          i={box.index}
                        </span>
                        <span className="flex-1 font-mono text-sm">
                          <Hash value={box.entry.ref.txId} edge={6} copyable={false} />
                          <span className="text-whisper">
                            #{box.entry.ref.outputIndex}
                          </span>
                        </span>
                        <span className="font-mono text-sm" data-num>
                          {ada} ₳
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {selectedBoxes.length > 0 && (
                <p className="text-xs text-muted">
                  {t("withdraw.selection_summary", {
                    count: selectedBoxes.length,
                    total: formatAda(totalLovelace),
                  })}
                </p>
              )}
            </div>
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
          </div>
        </fieldset>
      </form>

      {selectedBoxes.length === 0 && ownedBoxes.length > 0 && !submitting && (
        <p className="mt-4 text-xs text-whisper">
          {t("withdraw.no_box_selected")}
        </p>
      )}

      {submitting && (
        <div className="lj-overlay__indicator">
          <div className="lj-spinner" aria-label={t("withdraw.submitting")} />
        </div>
      )}
    </section>
  );
}
