// App-level error boundary.
//
// React swallows render errors and shows nothing — without a boundary,
// a stack-trace inside any route effectively white-screens the entire
// app, masking the cause. The boundary catches the error, logs to the
// dev console (no telemetry per CLAUDE.md), and renders a calm coral
// card with "Reload" + "Reset state" actions.
//
// "Reset state" wipes the dev-only `?advanced=1` localStorage overrides
// (the only state we own at rest, now that the BIP-39 vault is gone)
// and reloads. Useful when a bad override is what triggered the crash.
//
// We deliberately don't try to recover in-place — render errors usually
// mean a downstream component invariant broke, and trying to render the
// same tree again hits the same path. A reload is the honest fix.

import React, { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[lovejoin] uncaught render error:", error, info);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return <ErrorScreen error={this.state.error} />;
    }
    return this.props.children;
  }
}

function ErrorScreen({ error }: { error: Error }) {
  const { t } = useTranslation();

  const onReload = () => {
    window.location.reload();
  };
  const onResetState = () => {
    try {
      // Only the advanced-mode overrides are persisted at rest — wipe
      // them, then reload onto the build-time defaults. Anything else
      // (vault, scan, etc.) is in-memory and resets naturally on
      // reload.
      window.localStorage.removeItem("lovejoin.config.v1");
    } catch {
      /* ignore quota / private-mode errors */
    }
    window.location.reload();
  };

  return (
    <main className="lj-main" role="alert">
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <p className="lj-eyebrow">{t("error.boundary_eyebrow")}</p>
            <h2 className="lj-card__title">{t("error.boundary_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted leading-relaxed max-w-prose">
          {t("error.boundary_lede")}
        </p>
        <div className="lj-banner lj-banner--coral mt-4">
          <span className="lj-banner__title">{error.name || "Error"}</span>
          <span className="lj-banner__detail">{error.message}</span>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" className="lj-btn lj-btn--primary" onClick={onReload}>
            {t("error.boundary_reload")}
          </button>
          <button type="button" className="lj-btn" onClick={onResetState}>
            {t("error.boundary_reset")}
          </button>
        </div>
      </section>
    </main>
  );
}
