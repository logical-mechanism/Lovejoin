// App shell — header (with wallet pill) + outlet for the active route.
//
// Spec: §"Layout" + M6.5 design pass + M6.5+ punch-list
// (L2 dev-only AdvancedPanel, M7 sr-only h1 per route).
//
// The user-facing Configuration panel that M6 mounted unconditionally is
// gone — runtime config now ships baked from Vite env vars (see
// ui/.env.example). A developer-only `?advanced=1` query string surfaces
// the same overrides panel inline; production users never see config UI,
// and the panel itself tree-shakes out of the production bundle because
// the mount is gated behind `import.meta.env.DEV`.

import { Link, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Header } from "../components/Header.js";
import { AdvancedPanel } from "../components/AdvancedPanel.js";
import { ProviderBadge } from "../components/BackendStatus.js";
import { useAppState } from "../lib/store.js";
import { isAdvancedMode } from "../lib/sdk.js";

export function Layout() {
  const { t } = useTranslation();
  const { config, addressesError } = useAppState();
  // The advanced overrides panel only lives in dev builds. The
  // `?advanced=1` query param still gates the UI inside dev, so the
  // localStorage override + Blockfrost-key-in-the-URL story stays
  // identical for developers; production builds ship without the panel
  // at all (Vite tree-shakes the dead branch).
  const advanced = import.meta.env.DEV && isAdvancedMode();
  const location = useLocation();
  const routeKey = routeTitleKey(location.pathname);

  return (
    <div className="lj-shell">
      {/* Skip link is the first focusable element on every page so
       * keyboard / AT users can jump past the sticky header + main nav
       * straight to the route content. WCAG 2.4.1 (Bypass Blocks). The
       * link is visually hidden until it receives focus, then becomes a
       * solid pill in the top-left. */}
      <a href="#lj-main" className="lj-skip-link">
        {t("a11y.skip_to_main")}
      </a>
      <Header />
      <main id="lj-main" className="lj-main" tabIndex={-1}>
        <h1 className="sr-only">{t(routeKey)}</h1>
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
        <ProviderBadge />
        <span className="lj-footer__sep">·</span>
        <Link to="/help" className="lj-footer__link">
          {t("nav.help")}
        </Link>
      </footer>
    </div>
  );
}

/**
 * Map a route path to the i18n key used for the sr-only page heading.
 *
 * Why this exists: every inner route renders its content inside an
 * `lj-card` with an `<h2>` in the card head, so document outlines were
 * starting at h2. Adding one visually-hidden `<h1>` per route restores
 * the AT/SEO-friendly heading hierarchy without touching the visual
 * design. Route paths are stable and few; a dispatch table is simpler
 * than a lookup hook.
 */
function routeTitleKey(pathname: string): string {
  if (pathname === "/" || pathname === "") return "page_title.home";
  if (pathname.startsWith("/deposit")) return "page_title.deposit";
  if (pathname.startsWith("/donate")) return "page_title.donate";
  if (pathname.startsWith("/pool")) return "page_title.pool";
  if (pathname.startsWith("/protocol")) return "page_title.protocol";
  if (pathname.startsWith("/help")) return "page_title.help";
  if (pathname.startsWith("/vault/")) return "page_title.box";
  if (pathname.startsWith("/vault")) return "page_title.vault";
  // /withdraw redirects to /vault but is briefly hit during the redirect.
  if (pathname.startsWith("/withdraw")) return "page_title.vault";
  return "page_title.app";
}
