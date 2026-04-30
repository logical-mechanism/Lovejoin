// Wallet picker modal — opens from the header when no wallet is connected.
//
// Spec: M6.5 — "installed-wallet picker rendered as a modal on click; the
// WalletPanel section disappears as a free-floating block."
//
// The modal lists every CIP-30 wallet the browser has injected. We rely on
// mesh's `BrowserWallet.getInstalledWallets()` for discovery and
// `BrowserWallet.enable(id)` for the connect handshake. The mesh import is
// lazy via `lib/sdk.ts` so users without any wallet installed don't pay the
// libsodium load just to read the help text.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { connectWallet, listInstalledWallets } from "../lib/sdk.js";
import { useAppState } from "../lib/store.js";
import { Modal } from "./ui/Modal.js";

export interface WalletModalProps {
  open: boolean;
  onClose: () => void;
  onConnected: (args: {
    wallet: import("@meshsdk/core").BrowserWallet;
    walletId: string;
    changeAddress: string;
  }) => void;
}

interface InstalledWallet {
  id: string;
  name: string;
  icon: string;
}

export function WalletModal({ open, onClose, onConnected }: WalletModalProps) {
  const { t } = useTranslation();
  const { config } = useAppState();
  const [wallets, setWallets] = useState<InstalledWallet[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setWallets(null);
    setError(null);
    listInstalledWallets()
      .then((ws) => {
        if (!cancelled) setWallets(ws.map((w) => ({ id: w.id, name: w.name, icon: w.icon })));
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const onPick = async (w: InstalledWallet) => {
    setBusyId(w.id);
    setError(null);
    try {
      const wallet = await connectWallet(w.id);
      // Network-id sanity. CIP-30 returns 0 for testnets (preprod /
      // preview / custom) and 1 for mainnet. Without this guard a user
      // on Lace-mainnet pointing at the preprod build would just see
      // cryptic tx-build failures later. Fail loud, fail early.
      const networkId = await wallet.getNetworkId();
      const expectedId = config.network === "mainnet" ? 1 : 0;
      if (networkId !== expectedId) {
        const walletNet = networkId === 1 ? "mainnet" : "testnet";
        throw new Error(
          t("wallet.network_mismatch", {
            walletNet,
            appNet: config.network,
          }),
        );
      }
      const changeAddress = await wallet.getChangeAddress();
      onConnected({ wallet, walletId: w.id, changeAddress });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t("wallet.modal_title")}>
      <header className="mb-6">
        <p className="lj-eyebrow">{t("wallet.modal_eyebrow")}</p>
        <h2 className="mt-2 font-display text-2xl font-light tracking-tight text-paper">
          {t("wallet.modal_title")}
        </h2>
        <p className="mt-2 text-sm text-muted">{t("wallet.modal_lede")}</p>
      </header>

      {wallets === null && !error && (
        <div className="lj-loading">{t("wallet.scanning")}</div>
      )}

      {wallets !== null && wallets.length === 0 && (
        <div className="lj-empty">
          <p className="lj-empty__title">{t("wallet.no_wallets_title")}</p>
          <p>{t("wallet.no_wallets")}</p>
        </div>
      )}

      {wallets !== null && wallets.length > 0 && (
        <ul className="flex flex-col divide-y divide-rule">
          {wallets.map((w) => {
            const isConnecting = busyId === w.id;
            const isOtherBusy = busyId !== null && !isConnecting;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => onPick(w)}
                  disabled={busyId !== null}
                  aria-busy={isConnecting}
                  className={`flex w-full items-center gap-3 px-1 py-3 text-left transition-colors hover:bg-surface disabled:cursor-not-allowed ${
                    isOtherBusy ? "opacity-40" : ""
                  }`}
                >
                  {w.icon ? (
                    <img src={w.icon} alt="" className="h-7 w-7 rounded" />
                  ) : (
                    <span className="h-7 w-7 rounded bg-rise" />
                  )}
                  <span className="flex-1 capitalize">{w.name || w.id}</span>
                  {isConnecting ? (
                    <span className="flex items-center gap-2 text-xs text-paper">
                      <span
                        className="lj-spinner lj-spinner--sm"
                        aria-hidden="true"
                      />
                      {t("wallet.connecting")}
                    </span>
                  ) : (
                    <span className="text-xs text-whisper">→</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <div className="lj-banner lj-banner--coral mt-4">
          <span className="lj-banner__title">{t("wallet.connect_error", { message: error })}</span>
        </div>
      )}

      <footer className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          disabled={busyId !== null}
          className="lj-btn lj-btn--quiet"
        >
          {t("common.cancel")}
        </button>
      </footer>
    </Modal>
  );
}
