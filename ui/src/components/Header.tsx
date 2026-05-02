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
import { Modal } from "./ui/Modal.js";
import { StatusDot } from "./ui/StatusDot.js";
import { WalletModal } from "./WalletModal.js";
import { LanguageSwitcher } from "./LanguageSwitcher.js";

export function Header() {
  const { t } = useTranslation();
  const { wallet, walletId, changeAddress, setWallet } = useAppState();
  const [modalOpen, setModalOpen] = useState(false);
  // Disconnect needs a confirm step — the pill is one of the most-
  // hovered targets in the header, and a slipped click cost the user
  // a fresh signData round-trip + pool rescan. Cheap to require an
  // explicit confirmation; matches the existing "disconnect_confirm"
  // i18n key the M6 wallet section already had reserved.
  const [disconnectOpen, setDisconnectOpen] = useState(false);

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
          <NavLink to="/donate">{t("nav.donate")}</NavLink>
          <NavLink to="/protocol">{t("nav.protocol")}</NavLink>
          <NavLink to="/help">{t("nav.help")}</NavLink>
        </nav>

        <LanguageSwitcher />

        {wallet ? (
          <button
            type="button"
            className="lj-wallet-pill"
            onClick={() => setDisconnectOpen(true)}
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

      <Modal
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        title={t("wallet.disconnect_title")}
      >
        <header className="mb-5">
          <p className="lj-eyebrow">{t("wallet.disconnect_eyebrow")}</p>
          <h2 className="mt-2 font-display text-2xl font-light tracking-tight text-paper">
            {t("wallet.disconnect_title")}
          </h2>
          <p className="mt-2 text-sm text-muted">{t("wallet.disconnect_lede")}</p>
        </header>
        <footer className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setDisconnectOpen(false)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="lj-btn lj-btn--danger"
            onClick={() => {
              setDisconnectOpen(false);
              setWallet(null);
            }}
          >
            {t("wallet.disconnect_confirm")}
          </button>
        </footer>
      </Modal>
    </header>
  );
}
