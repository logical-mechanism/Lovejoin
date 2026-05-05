// Confirmation modal for the per-row "Mix this box" action. Wraps
// the Modal primitive with mix-specific copy. The actual workflow
// runs in `useMixThisBox` (lib/use-mix-this-box.ts); this component
// is purely presentational.

import { useTranslation } from "react-i18next";

import { Modal } from "./ui/Modal.js";

export interface MixReviewProps {
  open: boolean;
  n: number;
  onClose: () => void;
  onConfirm: () => void;
}

export function MixReview({ open, n, onClose, onConfirm }: MixReviewProps) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={t("vault.mix_row_confirm_title")}>
      <header className="mb-5">
        <p className="lj-eyebrow">{t("vault.mix_row_confirm_eyebrow")}</p>
        <h2 className="mt-2 font-display text-2xl font-light tracking-tight text-paper">
          {t("vault.mix_row_confirm_title")}
        </h2>
        <p className="mt-2 text-sm text-muted">{t("vault.mix_row_confirm_lede", { n })}</p>
      </header>
      <footer className="mt-6 flex justify-end gap-2">
        <button type="button" className="lj-btn lj-btn--quiet" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button type="button" className="lj-btn lj-btn--primary" onClick={onConfirm}>
          {t("vault.mix_row_confirm_submit")}
        </button>
      </footer>
    </Modal>
  );
}
