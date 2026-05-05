// Paginated owned-boxes table with selection state + a per-row "Mix
// this box" button. Extracted from routes/Vault.tsx during the
// issue #97 split.
//
// Behaviour-preserving: pagination state lives inside this component
// (purely visual), but selection state is owned by the parent so the
// withdraw form can read which boxes are checked.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Hash } from "./ui/Hash.js";
import { formatAda } from "../lib/format.js";
import type { OwnedBox } from "../lib/vault.js";

const PAGE_SIZE = 10;

export interface VaultTableProps {
  boxes: OwnedBox[];
  pendingTxRefs: ReadonlySet<string>;
  selectedRefs: ReadonlySet<string>;
  selectedCount: number;
  selectedTotalLovelace: bigint;
  onToggleRef: (ref: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  // Per-row Mix button:
  mixingRef: string | null;
  mixDisabled: boolean;
  mixDisabledTitle?: string;
  onRequestMix: (ref: string) => void;
  // True while a withdraw submit is in flight; gates row checkbox + Mix.
  formSubmitting: boolean;
}

export function VaultTable({
  boxes,
  pendingTxRefs,
  selectedRefs,
  selectedCount,
  selectedTotalLovelace,
  onToggleRef,
  onSelectAll,
  onClearAll,
  mixingRef,
  mixDisabled,
  mixDisabledTitle,
  onRequestMix,
  formSubmitting,
}: VaultTableProps) {
  const { t } = useTranslation();
  // Pagination keeps the destination input + Withdraw button in view
  // when the vault holds more than one page of boxes. Selection state
  // is keyed by ref upstream, so it survives page changes without
  // extra plumbing.
  const [boxPage, setBoxPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(boxes.length / PAGE_SIZE));
  const safeBoxPage = Math.min(boxPage, totalPages - 1);
  const visibleBoxes = boxes.slice(safeBoxPage * PAGE_SIZE, (safeBoxPage + 1) * PAGE_SIZE);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="lj-field__label">{t("withdraw.select_boxes")}</span>
        <div className="flex gap-3 text-xs">
          <button
            type="button"
            onClick={onSelectAll}
            className="text-muted underline-offset-2 hover:underline disabled:opacity-50"
            disabled={formSubmitting || selectedCount === boxes.length}
          >
            {t("withdraw.select_all")}
          </button>
          <button
            type="button"
            onClick={onClearAll}
            className="text-muted underline-offset-2 hover:underline disabled:opacity-50"
            disabled={formSubmitting || selectedCount === 0}
          >
            {t("withdraw.clear_selection")}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="lj-table">
          <caption className="sr-only">{t("withdraw.table_caption")}</caption>
          <thead>
            <tr>
              <th scope="col" className="w-8">
                <span className="sr-only">{t("withdraw.column_select")}</span>
              </th>
              <th scope="col">
                <abbr title={t("withdraw.column_index_long")}>i</abbr>
              </th>
              <th scope="col">{t("common.tx_hash")}</th>
              <th scope="col" className="lj-table__num">
                <abbr title={t("vault.column_rounds_long")}>{t("vault.column_rounds")}</abbr>
              </th>
              <th scope="col" className="lj-table__num">
                <span className="sr-only">{t("vault.column_action")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleBoxes.map((box) => {
              const ref = `${box.entry.ref.txId.toLowerCase()}#${box.entry.ref.outputIndex}`;
              const checked = selectedRefs.has(ref);
              // Pending = in flight from a Withdraw or owned-input
              // Mix this session. We dim the row, lock the checkbox,
              // and surface a small "in flight" eyebrow so the user
              // can see the box is on its way out.
              const pending = pendingTxRefs.has(ref);
              const rowClasses = [
                pending ? "" : "cursor-pointer",
                checked && !pending ? "bg-rise" : "",
                pending ? "opacity-50" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <tr
                  key={ref}
                  className={rowClasses}
                  onClick={pending ? undefined : () => onToggleRef(ref)}
                  aria-busy={pending}
                >
                  <td className="text-center">
                    <input
                      type="checkbox"
                      name="box-select"
                      checked={checked}
                      onChange={() => onToggleRef(ref)}
                      onClick={(e) => e.stopPropagation()}
                      disabled={pending || formSubmitting}
                      className="accent-paper disabled:cursor-not-allowed"
                      aria-label={t("withdraw.select_boxes")}
                    />
                  </td>
                  <td className="lj-table__num">
                    {pending ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />
                        <span className="text-whisper text-xs uppercase tracking-wider">
                          {t("vault.box_pending")}
                        </span>
                      </span>
                    ) : (
                      box.index
                    )}
                  </td>
                  <td>
                    <Hash value={box.entry.ref.txId} edge={6} />
                    <span className="text-whisper text-xs">#{box.entry.ref.outputIndex}</span>
                  </td>
                  <td className="lj-table__num">
                    {typeof box.generation === "number" ? box.generation : "—"}
                  </td>
                  <td className="lj-table__num">
                    <button
                      type="button"
                      className="lj-btn lj-btn--quiet lj-btn--sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRequestMix(ref);
                      }}
                      disabled={pending || formSubmitting || mixingRef !== null || mixDisabled}
                      title={mixDisabled ? mixDisabledTitle : undefined}
                    >
                      {mixingRef === ref && (
                        <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />
                      )}
                      {mixingRef === ref ? t("vault.mix_row_submitting") : t("vault.mix_row")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <nav
          className="mt-3 flex items-center justify-between gap-3"
          aria-label={t("vault.pagination_aria")}
        >
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setBoxPage((p) => Math.max(0, p - 1))}
            disabled={safeBoxPage === 0}
          >
            ← {t("vault.prev_page")}
          </button>
          <span className="text-xs text-muted" aria-live="polite">
            {t("vault.page_indicator", {
              current: safeBoxPage + 1,
              total: totalPages,
            })}
          </span>
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setBoxPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safeBoxPage >= totalPages - 1}
          >
            {t("vault.next_page")} →
          </button>
        </nav>
      )}
      {selectedCount > 0 && (
        <p className="text-xs text-muted">
          {t("withdraw.selection_summary", {
            count: selectedCount,
            total: formatAda(selectedTotalLovelace),
          })}
        </p>
      )}
    </div>
  );
}
