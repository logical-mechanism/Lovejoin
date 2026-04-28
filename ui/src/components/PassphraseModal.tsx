// Vault unlock prompt — shown by routes that need decrypted box secrets
// (Vault, Box, Withdraw) before the user has unlocked the vault.
//
// Spec: docs/spec/06-ui.md §"Key storage" — the vault is opt-in but, when
// used, must require a passphrase. We don't auto-unlock on page load; the
// user explicitly enters the passphrase per session.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAppState } from "../lib/store.js";

export function PassphraseModal() {
  const { t } = useTranslation();
  const { unlockVault, vaultError, destroyVault } = useAppState();
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase) return;
    setBusy(true);
    try {
      await unlockVault(passphrase);
      setPassphrase("");
    } catch {
      // store sets vaultError; the inline error block below renders it.
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4">
      <h2 className="text-lg font-semibold">{t("vault.unlock_title")}</h2>
      <p className="mt-1 text-xs text-gray-600">{t("vault.unlock_explainer")}</p>
      <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => void onSubmit(e)}>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoFocus
          autoComplete="current-password"
          placeholder={t("vault.passphrase_placeholder")}
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || passphrase.length === 0}
          className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? t("vault.unlocking") : t("vault.unlock")}
        </button>
      </form>
      {vaultError && (
        <p className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
          {vaultError}
        </p>
      )}
      <details className="mt-3 text-xs text-gray-600">
        <summary className="cursor-pointer">{t("vault.forgot_summary")}</summary>
        <p className="mt-2">{t("vault.forgot_explainer")}</p>
        {!showResetConfirm ? (
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="mt-2 rounded border border-red-300 px-2 py-1 text-xs text-red-700"
          >
            {t("vault.reset_button")}
          </button>
        ) : (
          <div className="mt-2 flex flex-col gap-2 rounded border border-red-300 bg-red-50 p-2">
            <p>{t("vault.reset_confirm_explainer")}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void destroyVault()}
                className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white"
              >
                {t("vault.reset_confirm_yes")}
              </button>
              <button
                type="button"
                onClick={() => setShowResetConfirm(false)}
                className="rounded border border-gray-300 px-2 py-1 text-xs"
              >
                {t("vault.reset_confirm_cancel")}
              </button>
            </div>
          </div>
        )}
      </details>
    </section>
  );
}
