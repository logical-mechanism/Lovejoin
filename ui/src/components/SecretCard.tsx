// Save-NOW UI for a freshly-generated box-ownership secret.
//
// Spec: docs/spec/06-ui.md §"Deposit" — "Generate box-ownership secret in
// browser; save-NOW UX (copyable hex, downloadable JSON, optional encrypted
// IndexedDB)."
//
// Two affordances side-by-side: copy to clipboard + download as JSON. The
// vault-stored variant is implicit — once the user has unlocked the vault
// the deposit flow auto-saves the box, and SecretCard surfaces a green
// "saved to vault" affirmation.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { StoredBox } from "../storage/secrets.js";

export interface SecretCardProps {
  box: StoredBox;
  /** True if this box has been encrypted into the vault. */
  savedToVault: boolean;
}

export function SecretCard({ box, savedToVault }: SecretCardProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(formatExport(box));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const onDownload = () => {
    const blob = new Blob([formatExport(box)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lovejoin-box-${box.txId.slice(0, 8)}-${box.outputIndex}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <section className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-amber-900">
          {t("secret_card.title")}
        </h3>
        {savedToVault && (
          <span className="rounded bg-green-200 px-2 py-0.5 text-xs text-green-900">
            {t("secret_card.saved_to_vault")}
          </span>
        )}
      </header>
      <p className="mt-1 text-xs text-amber-900">{t("secret_card.warning")}</p>
      <dl className="mt-3 grid grid-cols-1 gap-1 text-xs">
        <Row label={t("secret_card.label")} value={box.label} />
        <Row label={t("secret_card.tx")} value={`${box.txId}#${box.outputIndex}`} />
        <Row label={t("secret_card.secret")} value={box.ownerSecretHex} mono />
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void onCopy()}
          className="rounded border border-amber-400 bg-white px-2 py-1 text-xs"
        >
          {copied ? t("secret_card.copied") : t("secret_card.copy")}
        </button>
        <button
          type="button"
          onClick={onDownload}
          className="rounded border border-amber-400 bg-white px-2 py-1 text-xs"
        >
          {t("secret_card.download")}
        </button>
      </div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
      <dt className="font-medium text-amber-900">{label}:</dt>
      <dd className={`break-all text-amber-900 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function formatExport(box: StoredBox): string {
  return JSON.stringify(box, null, 2);
}
