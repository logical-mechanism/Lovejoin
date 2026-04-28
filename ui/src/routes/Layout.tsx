// App shell — header (with wallet pill) + outlet for the active route.
//
// Spec: docs/spec/06-ui.md §"Layout" + M6.5 design pass. The user-facing
// Configuration panel that M6 mounted unconditionally is gone — runtime
// config now ships baked from Vite env vars (see ui/.env.example). A
// developer-only `?advanced=1` query string surfaces the same overrides
// panel inline; production users never see config UI.

import { Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Header } from "../components/Header.js";
import { AdvancedPanel } from "../components/AdvancedPanel.js";
import { useAppState } from "../lib/store.js";
import { isAdvancedMode } from "../lib/sdk.js";

export function Layout() {
  const { t } = useTranslation();
  const { config, addressesError } = useAppState();
  const advanced = isAdvancedMode();

  return (
    <div className="lj-shell">
      <Header />
      <main className="lj-main">
        {addressesError && (
          <div role="alert" className="lj-banner lj-banner--amber">
            <span className="lj-banner__title">
              {t("config.missing_addresses", { network: config.network })}
            </span>
            <span className="lj-banner__detail">{addressesError}</span>
          </div>
        )}
        {advanced && <AdvancedPanel />}
        <Outlet />
      </main>
      <footer className="lj-footer">
        <span className="lj-footer__mark">{t("brand.mark")}</span>
        <span className="lj-footer__sep">·</span>
        <span className="lj-footer__net">{config.network}</span>
        <span className="lj-footer__sep">·</span>
        <span className="lj-footer__warn">{t("app.preprod_banner")}</span>
      </footer>
    </div>
  );
}
