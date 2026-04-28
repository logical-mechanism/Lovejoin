// In-memory "my boxes" list — only what the dev has just deposited in this
// session. Persistence (encrypted IndexedDB) lands in M6; M3.5 keeps it in
// component state so the slice stays small and forces the dev to verify
// withdraw inside the same tab.

import { useTranslation } from "react-i18next";

import type { DepositedBox } from "./DepositPanel.js";

export interface MyBoxesPanelProps {
  boxes: DepositedBox[];
  onSelect: (box: DepositedBox) => void;
}

export function MyBoxesPanel({ boxes, onSelect }: MyBoxesPanelProps) {
  const { t } = useTranslation();
  return (
    <section className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">{t("boxes.section_title")}</h2>
      {boxes.length === 0 ? (
        <div className="mt-3 text-sm text-gray-600">
          <p>{t("boxes.empty")}</p>
          <p className="mt-1 text-xs text-gray-500">{t("boxes.empty_hint")}</p>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-gray-100">
          {boxes.map((box) => (
            <li
              key={`${box.txId}#${box.outputIndex}`}
              className="flex flex-wrap items-center gap-3 py-2 text-xs"
            >
              <span className="font-mono">{box.label}</span>
              <span className="font-mono text-gray-600">
                {box.txId.slice(0, 12)}…#{box.outputIndex}
              </span>
              <button
                type="button"
                onClick={() => copy(box.ownerSecretHex)}
                className="rounded border border-gray-300 px-2 py-0.5"
                title={box.ownerSecretHex}
              >
                {t("boxes.copy")}
              </button>
              <button
                type="button"
                onClick={() => onSelect(box)}
                className="rounded bg-black px-2 py-0.5 font-medium text-white"
              >
                {t("boxes.use_for_withdraw")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function copy(text: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(text);
}
