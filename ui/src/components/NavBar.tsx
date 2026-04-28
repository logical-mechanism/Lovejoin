// Top-of-page nav for the M6 router shell.
//
// Five primary destinations, mapped to the routes in routes/. The active
// link gets a dark underline for keyboard + screen-reader users.

import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";

const LINK_BASE =
  "rounded px-2 py-1 text-sm font-medium text-gray-600 hover:text-black";
const LINK_ACTIVE = "text-black underline underline-offset-4";

const ROUTES = [
  { to: "/", labelKey: "nav.home", end: true },
  { to: "/deposit", labelKey: "nav.deposit", end: false },
  { to: "/pool", labelKey: "nav.pool", end: false },
  { to: "/vault", labelKey: "nav.vault", end: false },
  { to: "/withdraw", labelKey: "nav.withdraw", end: false },
] as const;

export function NavBar() {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("nav.aria_label")} className="flex flex-wrap gap-2">
      {ROUTES.map((r) => (
        <NavLink
          key={r.to}
          to={r.to}
          end={r.end}
          className={({ isActive }) =>
            `${LINK_BASE} ${isActive ? LINK_ACTIVE : ""}`.trim()
          }
        >
          {t(r.labelKey)}
        </NavLink>
      ))}
    </nav>
  );
}
