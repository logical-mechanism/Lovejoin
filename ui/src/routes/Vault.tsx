// Vault — owner-side view of the boxes the user holds across sessions.
//
// Spec: docs/spec/06-ui.md §"Vault" — boxes the user owns, derived by
// scanning the pool with each saved secret. Per-row: id, denom, generation,
// last mixed, withdraw button. Import box-secret button.
//
// Implementation note: the M3.5 vertical slice tracked boxes in memory.
// M6 swaps that for the encrypted IndexedDB vault — once unlocked, the
// stored boxes load and persist across reloads.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { PassphraseModal } from "../components/PassphraseModal.js";
import { useAppState } from "../lib/store.js";
import type { StoredBox } from "../storage/secrets.js";

export function Vault() {
  const { t } = useTranslation();
  const { vault, boxes, lockVault, addBox, removeBox } = useAppState();
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  if (!vault) {
    return (
      <>
        <PassphraseModal />
        <p className="text-xs text-gray-600">{t("vault.unlock_to_view")}</p>
      </>
    );
  }

  const onImport = async () => {
    setImportError(null);
    setImportBusy(true);
    try {
      const parsed = JSON.parse(importJson) as Partial<StoredBox>;
      if (
        typeof parsed.txId !== "string" ||
        typeof parsed.outputIndex !== "number" ||
        typeof parsed.ownerSecretHex !== "string" ||
        typeof parsed.aHex !== "string" ||
        typeof parsed.bHex !== "string"
      ) {
        throw new Error(t("vault.import_invalid"));
      }
      const box: StoredBox = {
        txId: parsed.txId.toLowerCase(),
        outputIndex: parsed.outputIndex,
        ownerSecretHex: parsed.ownerSecretHex.toLowerCase(),
        aHex: parsed.aHex.toLowerCase(),
        bHex: parsed.bHex.toLowerCase(),
        label: parsed.label ?? parsed.bHex.slice(0, 16),
        rounds: parsed.rounds ?? 0,
        createdAt: parsed.createdAt ?? Date.now(),
      };
      await addBox(box);
      setImportJson("");
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <>
      <section className="rounded-md border border-gray-200 bg-white p-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("vault.title")}</h2>
          <button
            type="button"
            onClick={lockVault}
            className="rounded border border-gray-300 px-2 py-1 text-xs"
          >
            {t("vault.lock")}
          </button>
        </header>
        {boxes.length === 0 ? (
          <p className="mt-3 text-sm text-gray-600">{t("vault.empty")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100">
            {boxes.map((box) => (
              <li
                key={`${box.txId}#${box.outputIndex}`}
                className="flex flex-wrap items-center justify-between gap-3 py-2 text-xs"
              >
                <div className="flex flex-col">
                  <span className="font-mono font-semibold">{box.label}</span>
                  <span className="font-mono text-gray-600">
                    {box.txId.slice(0, 12)}…#{box.outputIndex}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Link
                    to={`/vault/${box.txId}/${box.outputIndex}`}
                    className="rounded border border-gray-300 px-2 py-1"
                  >
                    {t("vault.open_box")}
                  </Link>
                  <button
                    type="button"
                    onClick={() => void removeBox(box.txId, box.outputIndex)}
                    className="rounded border border-red-300 px-2 py-1 text-red-700"
                  >
                    {t("vault.forget_box")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold">{t("vault.import_title")}</h3>
        <p className="mt-1 text-xs text-gray-600">{t("vault.import_explainer")}</p>
        <textarea
          value={importJson}
          onChange={(e) => setImportJson(e.target.value)}
          placeholder='{"txId":"…","outputIndex":0,"ownerSecretHex":"…","aHex":"…","bHex":"…"}'
          rows={5}
          className="mt-2 w-full rounded border border-gray-300 p-2 font-mono text-xs"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void onImport()}
            disabled={importBusy || importJson.trim().length === 0}
            className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {importBusy ? t("vault.import_busy") : t("vault.import_button")}
          </button>
          {importError && (
            <span className="text-xs text-red-700">{importError}</span>
          )}
        </div>
      </section>
    </>
  );
}
