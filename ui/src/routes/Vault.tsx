// Vault — wallet-derived owned-boxes view + lock + tier-2 BIP-39 fallback.
//
// Spec: docs/spec/06-ui.md M6.5 — "wallet-derived vault (default flow) —
// zero new keys for the user to manage. On first 'unlock' the connected
// CIP-30 wallet does a single signData(stakeAddr, 'lovejoin/owner/v1');
// ... seed = blake2b_256(signature_bytes); per-deposit owner secret x_i =
// scalar_from_hkdf(seed, 'lovejoin/owner/v1', counter=i) reduced mod r.
// The seed is held in memory for the session only — IndexedDB stores
// nothing. Locking the vault drops the seed; unlocking re-prompts the
// wallet for one signature."

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { Hash } from "../components/ui/Hash.js";
import { StatusDot } from "../components/ui/StatusDot.js";
import { Bip39FallbackPanel } from "../components/Bip39FallbackPanel.js";
import { formatAda } from "../lib/format.js";

export function Vault() {
  const { t } = useTranslation();
  const {
    wallet,
    vault,
    vaultBusy,
    vaultError,
    ownedBoxes,
    poolSize,
    scanError,
    unlockWithWallet,
    lockVault,
    rescan,
  } = useAppState();
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

  return (
    <>
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>
              {vault.kind === "wallet"
                ? t("vault.eyebrow")
                : t("vault.fallback_title")}
            </Eyebrow>
            <h2 className="lj-card__title">{t("vault.title")}</h2>
          </div>
          <div className="flex items-center gap-2">
            <StatusDot tone="ok" label="unlocked" />
            <button type="button" className="lj-btn lj-btn--quiet" onClick={() => void rescan()}>
              {t("vault.scan_again")}
            </button>
            <button type="button" className="lj-btn lj-btn--quiet" onClick={lockVault}>
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
          <div className="mt-6 overflow-x-auto">
            <table className="lj-table">
              <thead>
                <tr>
                  <th>i</th>
                  <th>{t("common.tx_hash")}</th>
                  <th className="lj-table__num">b</th>
                  <th className="lj-table__num">{t("common.amount")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ownedBoxes.map((box) => {
                  const ada = formatAda(box.entry.utxo.lovelace);
                  return (
                    <tr key={`${box.entry.ref.txId}#${box.entry.ref.outputIndex}`}>
                      <td className="lj-table__num">{box.index}</td>
                      <td>
                        <Hash value={box.entry.ref.txId} edge={6} />
                        <span className="text-whisper text-xs">#{box.entry.ref.outputIndex}</span>
                      </td>
                      <td className="lj-table__num">
                        <Hash value={bytesToHexShort(box.entry.b)} edge={4} copyable={false} />
                      </td>
                      <td className="lj-table__num">{ada} ₳</td>
                      <td className="text-right">
                        <div className="inline-flex items-center gap-2">
                          <Link
                            to={`/vault/${box.entry.ref.txId}/${box.entry.ref.outputIndex}`}
                            className="lj-btn lj-btn--primary"
                          >
                            {t("vault.withdraw_box")}
                          </Link>
                          {/* Open is a desktop-only convenience — on mobile,
                           * the table already overflows horizontally so we
                           * collapse to the single primary action. */}
                          <Link
                            to={`/vault/${box.entry.ref.txId}/${box.entry.ref.outputIndex}?detail=1`}
                            className="lj-btn lj-btn--quiet hidden sm:inline-flex"
                          >
                            {t("vault.open_box")}
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function bytesToHexShort(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
