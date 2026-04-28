// Wallet picker / connect panel.
//
// Lists installed CIP-30 wallets, lets the user click one to connect, and
// surfaces the connected wallet's change address. The full BrowserWallet
// instance is lifted up to the parent App via `onWalletConnected` so the
// deposit + withdraw screens can pass it to the SDK tx builders.
//
// Why we lift state up instead of using context: the M3.5 slice is one
// page; introducing a wallet context now would be premature abstraction.
// M6's full UI will probably want one, but that's its problem to solve.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserWallet } from "@meshsdk/core";

import { connectWallet, listInstalledWallets } from "../lib/sdk.js";

interface WalletInfo {
  id: string;
  name: string;
  icon: string;
  version: string;
}

export interface WalletPanelProps {
  wallet: BrowserWallet | null;
  walletId: string | null;
  changeAddress: string | null;
  onWalletConnected: (args: {
    wallet: BrowserWallet;
    walletId: string;
    changeAddress: string;
  }) => void;
  onWalletDisconnected: () => void;
}

export function WalletPanel({
  wallet,
  walletId,
  changeAddress,
  onWalletConnected,
  onWalletDisconnected,
}: WalletPanelProps) {
  const { t } = useTranslation();
  const [installed, setInstalled] = useState<WalletInfo[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await listInstalledWallets();
      setInstalled(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onConnect = async (id: string) => {
    setConnecting(id);
    setError(null);
    try {
      const w = await connectWallet(id);
      const addr = await w.getChangeAddress();
      onWalletConnected({ wallet: w, walletId: id, changeAddress: addr });
    } catch (e) {
      setError(t("wallet.connect_error", { message: (e as Error).message }));
    } finally {
      setConnecting(null);
    }
  };

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("wallet.section_title")}</h2>
        <button
          type="button"
          onClick={refresh}
          className="text-xs text-gray-600 underline"
        >
          {t("wallet.refresh")}
        </button>
      </header>

      {wallet && walletId && changeAddress ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm">
            {t("wallet.connected_as", { wallet: walletId })}
          </p>
          <p className="break-all font-mono text-xs text-gray-700">
            <span className="font-sans text-gray-500">
              {t("wallet.address")}:{" "}
            </span>
            {changeAddress}
          </p>
          <button
            type="button"
            onClick={onWalletDisconnected}
            className="rounded border border-gray-300 px-3 py-1 text-sm"
          >
            {t("app.disconnect_wallet")}
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {installed.length === 0 && !error && (
            <p className="text-sm text-gray-600">{t("wallet.no_wallets")}</p>
          )}
          <ul className="grid gap-2 sm:grid-cols-2">
            {installed.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => void onConnect(w.id)}
                  disabled={connecting !== null}
                  className="flex w-full items-center gap-2 rounded border border-gray-300 px-3 py-2 text-sm hover:border-black disabled:opacity-50"
                >
                  {w.icon && (
                    <img
                      src={w.icon}
                      alt=""
                      className="h-5 w-5"
                      aria-hidden="true"
                    />
                  )}
                  <span className="flex-1 text-left">
                    {w.name}
                    <span className="ml-1 text-xs text-gray-500">
                      v{w.version}
                    </span>
                  </span>
                  {connecting === w.id && (
                    <span className="text-xs text-gray-500">
                      {t("wallet.connecting")}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
          {error}
        </p>
      )}
    </section>
  );
}
