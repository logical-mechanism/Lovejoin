// Advanced overrides — mounted only when `?advanced=1` is on the URL.
//
// Spec: M6.5 — "A developer-only ?advanced=1 query string surfaces an
// overrides panel that writes to localStorage; absent that flag, the
// production UI shows zero config UI."
//
// This is the same form the M6 Layout used to mount unconditionally; it
// now lives behind the gate so end users never see it. The panel writes
// to localStorage via `saveConfig`; the storage entry is only honoured by
// `loadConfig` when the advanced flag is present, so a user who navigated
// here once and back doesn't permanently mutate their UI.

import { useTranslation } from "react-i18next";

import { ConfigPanel } from "./ConfigPanel.js";
import { useAppState } from "../lib/store.js";
import { clearConfigOverrides, envDefaults } from "../lib/sdk.js";

export function AdvancedPanel() {
  const { t } = useTranslation();
  const { config, setConfig } = useAppState();

  const reset = () => {
    clearConfigOverrides();
    setConfig(envDefaults());
  };

  return (
    <section className="lj-card lj-card--quiet" aria-label={t("config.advanced_title")}>
      <header className="lj-card__head">
        <div>
          <p className="lj-eyebrow">{t("config.advanced_eyebrow")}</p>
          <h2 className="lj-card__title">{t("config.advanced_title")}</h2>
        </div>
        <button type="button" className="lj-btn lj-btn--quiet" onClick={reset}>
          {t("config.reset_overrides")}
        </button>
      </header>
      <p className="mb-4 text-sm text-muted">{t("config.advanced_lede")}</p>
      <ConfigPanel config={config} onChange={setConfig} />
    </section>
  );
}
