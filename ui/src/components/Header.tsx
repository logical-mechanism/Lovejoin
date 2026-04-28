// App header — brand mark on the left, primary nav, wallet pill on the right.
//
// Spec: docs/spec/06-ui.md §"Layout" + M6.5 — "connect/disconnect lives in
// the header (visible state + change-address truncated to one line);
// installed-wallet picker rendered as a modal on click; the WalletPanel
// section disappears as a free-floating block."

import { useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAppState } from "../lib/store.js";
import { Hash } from "./ui/Hash.js";
import { StatusDot } from "./ui/StatusDot.js";
import { WalletModal } from "./WalletModal.js";

export function Header() {
  const { t } = useTranslation();
  const { wallet, walletId, changeAddress, setWallet } = useAppState();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <header className="lj-header">
      <div className="lj-header__inner">
        <Link to="/" className="lj-brand">
          <span className="lj-brand__caret">⟨</span>
          <span>{t("brand.mark")}</span>
          <span className="lj-brand__caret">⟩</span>
        </Link>

        <nav className="lj-nav" aria-label={t("nav.aria_label")}>
          <NavLink to="/deposit">{t("nav.deposit")}</NavLink>
          <NavLink to="/pool">{t("nav.pool")}</NavLink>
          <NavLink to="/vault">{t("nav.vault")}</NavLink>
          <NavLink to="/protocol">{t("nav.protocol")}</NavLink>
        </nav>

        {wallet ? (
          <button
            type="button"
            className="lj-wallet-pill"
            onClick={() => setWallet(null)}
            title={t("app.disconnect_wallet")}
          >
            <span className="lj-wallet-pill__icon" />
            <StatusDot tone="ok" label="connected" />
            <span className="capitalize">{walletId ?? "wallet"}</span>
            <span className="lj-wallet-pill__addr">
              <Hash value={changeAddress ?? ""} edge={4} copyable={false} />
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="lj-btn lj-btn--primary"
            onClick={() => setModalOpen(true)}
          >
            {t("app.connect_wallet")}
          </button>
        )}
      </div>

      <WalletModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onConnected={(args) => setWallet(args)}
      />
    </header>
  );
}
