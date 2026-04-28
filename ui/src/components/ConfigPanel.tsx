// Runtime config panel — Blockfrost project ID + network selector.
//
// The vertical slice (M3.5) needs a per-developer Blockfrost key to talk to
// Preprod. Saved in localStorage so reloads don't lose it. Network is
// included for completeness even though only Preprod matters for the slice.
//
// This is intentionally a tiny dev-facing form, not a polished settings UI —
// the polished version is M6's job.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type Network,
  NETWORKS,
  type RuntimeConfig,
  saveConfig,
} from "../lib/sdk.js";

export interface ConfigPanelProps {
  config: RuntimeConfig;
  onChange: (next: RuntimeConfig) => void;
}

export function ConfigPanel({ config, onChange }: ConfigPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<RuntimeConfig>(config);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const apply = () => {
    saveConfig(draft);
    onChange(draft);
    setSavedAt(Date.now());
  };

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">{t("config.section_title")}</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col text-sm">
          <span className="font-medium">{t("config.network_label")}</span>
          <select
            className="mt-1 rounded border border-gray-300 px-2 py-1"
            value={draft.network}
            onChange={(e) =>
              setDraft({ ...draft, network: e.target.value as Network })
            }
          >
            {NETWORKS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          <span className="font-medium">{t("config.blockfrost_label")}</span>
          <input
            type="password"
            autoComplete="off"
            className="mt-1 rounded border border-gray-300 px-2 py-1 font-mono"
            value={draft.blockfrostProjectId}
            onChange={(e) =>
              setDraft({ ...draft, blockfrostProjectId: e.target.value })
            }
            placeholder={t("config.blockfrost_placeholder")}
          />
          <span className="mt-1 text-xs text-gray-500">
            {t("config.blockfrost_help")}
          </span>
        </label>
        <label className="flex flex-col text-sm">
          <span className="font-medium">{t("config.backend_url_label")}</span>
          <input
            type="text"
            autoComplete="off"
            className="mt-1 rounded border border-gray-300 px-2 py-1 font-mono"
            value={draft.backendUrl}
            onChange={(e) => setDraft({ ...draft, backendUrl: e.target.value })}
            placeholder={t("config.backend_url_placeholder")}
          />
          <span className="mt-1 text-xs text-gray-500">
            {t("config.backend_url_help")}
          </span>
        </label>
        <label className="flex flex-col text-sm">
          <span className="font-medium">
            {t("config.collateral_endpoint_label")}
          </span>
          <input
            type="text"
            autoComplete="off"
            className="mt-1 rounded border border-gray-300 px-2 py-1 font-mono"
            value={draft.collateralProviderEndpoint}
            onChange={(e) =>
              setDraft({ ...draft, collateralProviderEndpoint: e.target.value })
            }
            placeholder={t("config.collateral_endpoint_placeholder")}
          />
          <span className="mt-1 text-xs text-gray-500">
            {t("config.collateral_endpoint_help")}
          </span>
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={apply}
          disabled={
            draft.network === config.network &&
            draft.blockfrostProjectId === config.blockfrostProjectId &&
            draft.backendUrl === config.backendUrl &&
            draft.collateralProviderEndpoint === config.collateralProviderEndpoint
          }
          className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {t("config.save")}
        </button>
        {savedAt !== null && (
          <span className="text-xs text-green-700">{t("config.saved")}</span>
        )}
      </div>
    </section>
  );
}
