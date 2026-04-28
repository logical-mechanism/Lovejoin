// Pre-submit review block for the Withdraw flow.
//
// Spec: M6.5+ punch-list H1 — the irreversible Schnorr-withdraw needed
// an explicit "you will send X ₳ to addr_test1...xyz" panel above the
// submit button, not just the static mechanism-explanation banner the
// flow had previously. The review surfaces:
//
//   • Amount (ADA, thousands-grouped via formatAda)
//   • Destination (full bech32 address, click-to-copy via Hash)
//   • Address kind tag (stealth / regular-key) when validation passed
//
// This component is rendered by both /withdraw (the picker flow) and
// /vault/:tx/:idx (the Box-detail withdraw form), so the language and
// layout stay identical between the two.
//
// Validation feedback (invalid bech32, wrong network) is surfaced
// inline beside the destination input itself — not in this block —
// because the user is still typing when those states fire. The review
// only renders meaningful "kind" data once `validation.status === "ok"`.

import { useTranslation } from "react-i18next";

import { Hash } from "./ui/Hash.js";
import { formatAda } from "../lib/format.js";
import type { DestinationStatus } from "../lib/seedelf.js";

export interface WithdrawReviewProps {
  lovelace: bigint | number;
  destination: string;
  validation: DestinationStatus;
}

export function WithdrawReview({
  lovelace,
  destination,
  validation,
}: WithdrawReviewProps) {
  const { t } = useTranslation();
  const trimmed = destination.trim();
  const ok = validation.status === "ok";
  const isStealth = ok && validation.kind.kind === "stealth";

  return (
    <div className="lj-review" role="group" aria-label={t("withdraw.review_title")}>
      <span className="lj-eyebrow">{t("withdraw.review_title")}</span>
      <dl className="lj-review__rows">
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("withdraw.review_send")}</dt>
          <dd className="lj-review__value lj-review__value--num" data-num>
            {formatAda(lovelace)} ₳
          </dd>
        </div>
        <div className="lj-review__row">
          <dt className="lj-review__label">{t("withdraw.review_to")}</dt>
          <dd className="lj-review__value">
            {trimmed ? (
              <Hash value={trimmed} edge={12} />
            ) : (
              <span className="lj-review__placeholder">
                {t("withdraw.review_to_placeholder")}
              </span>
            )}
          </dd>
        </div>
        {ok && (
          <div className="lj-review__row">
            <dt className="lj-review__label">{t("withdraw.review_kind")}</dt>
            <dd className="lj-review__value lj-review__value--muted">
              {isStealth
                ? t("withdraw.review_kind_stealth")
                : t("withdraw.review_kind_regular")}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
