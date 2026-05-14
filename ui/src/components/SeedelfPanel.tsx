// SeedelfPanel — read-only stealth-wallet section that mounts inside the
// unlocked Vault.
//
// Spec: issue #135. Surfaces the user's Seedelf register set + funded
// balance derived from the same wallet-signed vault seed Lovejoin already
// holds for owner-secret derivation, domain-separated by HKDF info tag
// `lovejoin/seedelf/v1`.
//
// This first cut is read-only: we scan the wallet-contract address,
// classify owned UTxOs into registers (carrying a 5eed0e1f… NFT) vs
// funds (re-randomized payments), and render the totals. Mint / Send /
// Spend tx-builders are scoped for follow-up issues (see CHANGELOG /
// project memory for the M-roadmap reasoning).
//
// The panel renders nothing when the active network has no Seedelf
// deployment (e.g. `preview` until an operator configures it via
// VITE_SEEDELF_*). That's a fast `enabled` check from the hook.

import { useTranslation } from "react-i18next";

import { useAppState } from "../lib/store.js";
import { loadSeedelfAddresses } from "../lib/sdk.js";
import { useSeedelfState } from "../lib/use-seedelf.js";
import { Eyebrow } from "./ui/Eyebrow.js";

function formatAda(lovelace: bigint): string {
  // Mirrors the Vault's "X.X ADA" formatting so the totals look consistent
  // alongside owned-box rows. Two decimals — denominations are 10 ADA
  // multiples for Lovejoin but Seedelf funds can be arbitrary.
  const ada = Number(lovelace) / 1_000_000;
  return ada.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function truncate(hex: string, head = 8, tail = 6): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function SeedelfPanel() {
  const { t } = useTranslation();
  const { config } = useAppState();
  const seedelfAddresses = loadSeedelfAddresses(config.network);
  const state = useSeedelfState(seedelfAddresses);

  if (!state.enabled) {
    return null;
  }

  return (
    <section
      className="lj-card mt-8"
      aria-label={t("vault.seedelf.title")}
      data-testid="seedelf-panel"
    >
      <header className="lj-card__head">
        <div>
          <Eyebrow>{t("vault.seedelf.eyebrow")}</Eyebrow>
          <h3 className="lj-card__title">{t("vault.seedelf.title")}</h3>
        </div>
        <button
          type="button"
          className="lj-btn lj-btn--quiet"
          onClick={state.rescan}
          disabled={state.loading}
        >
          {state.loading && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
          {state.loading ? t("vault.seedelf.scanning") : t("vault.seedelf.rescan")}
        </button>
      </header>

      <p className="text-sm text-muted leading-relaxed max-w-prose">{t("vault.seedelf.lede")}</p>

      {state.error && (
        <div className="lj-banner lj-banner--coral mt-4">
          <span className="lj-banner__title">
            {t("vault.seedelf.scan_failed", { message: state.error })}
          </span>
        </div>
      )}

      {!state.error && state.registers.length === 0 && state.funds.length === 0 && (
        <div className="lj-empty mt-6">
          <p className="lj-empty__title">{t("vault.seedelf.empty_title")}</p>
          <p>{t("vault.seedelf.empty_hint")}</p>
        </div>
      )}

      {(state.registers.length > 0 || state.funds.length > 0) && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="lj-stat">
            <p className="lj-stat__label">{t("vault.seedelf.registers_label")}</p>
            <p className="lj-stat__value">{state.registers.length}</p>
          </div>
          <div className="lj-stat">
            <p className="lj-stat__label">{t("vault.seedelf.funds_label")}</p>
            <p className="lj-stat__value">{state.funds.length}</p>
          </div>
          <div className="lj-stat">
            <p className="lj-stat__label">{t("vault.seedelf.balance_label")}</p>
            <p className="lj-stat__value">
              {t("vault.seedelf.balance_ada", { amount: formatAda(state.totalLovelace) })}
            </p>
          </div>
        </div>
      )}

      {state.registers.length > 0 && (
        <div className="mt-6">
          <h4 className="text-sm font-semibold mb-2">{t("vault.seedelf.registers_heading")}</h4>
          <ul className="lj-list">
            {state.registers.map((r) => (
              <li key={`${r.utxo.ref.txId}#${r.utxo.ref.outputIndex}`} className="lj-list__item">
                <code className="text-xs">
                  {r.seedelfTokenHex
                    ? `5eed0e1f…${truncate(r.seedelfTokenHex.slice(8), 6, 4)}`
                    : truncate(`${r.utxo.ref.txId}#${r.utxo.ref.outputIndex}`)}
                </code>
                <span className="text-muted text-xs">
                  {t("vault.seedelf.index_label", { i: r.index })}
                </span>
                <span className="text-xs">
                  {t("vault.seedelf.balance_ada", { amount: formatAda(r.utxo.lovelace) })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 border-t border-rule pt-4">
        <p className="text-xs text-muted">{t("vault.seedelf.actions_coming_soon")}</p>
      </div>
    </section>
  );
}
