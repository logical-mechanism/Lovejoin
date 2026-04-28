// Home — 60-second explainer + network status.
//
// Spec: docs/spec/06-ui.md §"Home" — three blocks: a short explainer, the
// PoolStatus widget, a connect-wallet pointer.

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { PoolStatus } from "../components/PoolStatus.js";
import { useAppState } from "../lib/store.js";

export function Home() {
  const { t } = useTranslation();
  const { config, wallet } = useAppState();

  return (
    <>
      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="text-lg font-semibold">{t("home.title")}</h2>
        <p className="mt-2 text-sm text-gray-700">{t("home.explainer")}</p>
        <ul className="mt-3 list-disc pl-5 text-sm text-gray-700">
          <li>{t("home.bullet_deposit")}</li>
          <li>{t("home.bullet_mix")}</li>
          <li>{t("home.bullet_withdraw")}</li>
        </ul>
        <p className="mt-3 text-xs text-gray-600">{t("home.privacy_note")}</p>
      </section>

      <PoolStatus backendUrl={config.backendUrl} />

      {!wallet && (
        <section className="rounded-md border border-gray-200 bg-white p-4 text-sm">
          <p>{t("home.connect_prompt")}</p>
        </section>
      )}

      {wallet && (
        <section className="rounded-md border border-gray-200 bg-white p-4 text-sm">
          <p>{t("home.connected_prompt")}</p>
          <div className="mt-2 flex gap-3">
            <Link to="/deposit" className="font-medium underline">
              {t("nav.deposit")}
            </Link>
            <Link to="/pool" className="font-medium underline">
              {t("nav.pool")}
            </Link>
            <Link to="/vault" className="font-medium underline">
              {t("nav.vault")}
            </Link>
          </div>
        </section>
      )}
    </>
  );
}
