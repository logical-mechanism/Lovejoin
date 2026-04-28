// App shell — header + nav + outlet for the active route.
//
// Spec: docs/spec/06-ui.md §"Layout" — single-column SPA. Wallet picker
// and runtime config live in the header so every route has access to them
// without duplicating the panels.

import { Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { ConfigPanel } from "../components/ConfigPanel.js";
import { NavBar } from "../components/NavBar.js";
import { WalletPanel } from "../components/WalletPanel.js";
import { useAppState } from "../lib/store.js";

export function Layout() {
  const { t } = useTranslation();
  const {
    config,
    setConfig,
    addressesError,
    wallet,
    walletId,
    changeAddress,
    setWallet,
  } = useAppState();

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-6 py-5">
          <h1 className="text-2xl font-bold tracking-tight">{t("app.title")}</h1>
          <p className="text-sm text-gray-600">{t("app.tagline")}</p>
          <p className="text-xs text-amber-700">{t("app.preprod_banner")}</p>
          <NavBar />
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
        <details className="rounded border border-gray-200 bg-white p-2 text-sm">
          <summary className="cursor-pointer font-medium">
            {t("config.section_title")}
          </summary>
          <div className="mt-2">
            <ConfigPanel config={config} onChange={setConfig} />
          </div>
        </details>
        {addressesError && (
          <p
            role="alert"
            className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
          >
            {t("config.missing_addresses", { network: config.network })}
            <span className="ml-2 text-amber-700">({addressesError})</span>
          </p>
        )}
        <WalletPanel
          wallet={wallet}
          walletId={walletId}
          changeAddress={changeAddress}
          onWalletConnected={(args) => setWallet(args)}
          onWalletDisconnected={() => setWallet(null)}
        />
        <Outlet />
      </main>
    </div>
  );
}
