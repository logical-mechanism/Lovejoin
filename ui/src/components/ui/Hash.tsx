// Truncated hash / address display with click-to-copy.
//
// Cardano tx ids are 64-hex chars; bech32 addresses are ~100. Showing
// either in full is hostile to the eye. This component renders the
// first/last n characters with a middle ellipsis and copies the full
// value to the clipboard on click.
//
// A11y: the visible truncation is decorative — screen readers receive
// the full value via aria-label so blind users hear an unambiguous
// address rather than "0x12…ab". After a successful copy a polite
// aria-live region announces "Copied" exactly once, instead of forcing
// a live label change on the button itself (which can be re-announced
// noisily on every render).

import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface HashProps {
  value: string;
  /** Characters to keep at each end. Default 6. */
  edge?: number;
  /** When set, click copies the full string to the clipboard. */
  copyable?: boolean;
}

export function Hash({ value, edge = 6, copyable = true }: HashProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const display =
    value.length <= edge * 2 + 1
      ? value
      : `${value.slice(0, edge)}…${value.slice(-edge)}`;
  if (!copyable) {
    // Use <code> so AT can switch to character-by-character spelling on
    // these monospace blobs if the user asks for it. aria-label gives
    // the full value so a 10-char ellipsis preview doesn't strand SRs.
    return (
      <code className="lj-hash" title={value} aria-label={value}>
        {display}
      </code>
    );
  }
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — silent */
    }
  };
  const copyLabel = t("common.copy_value", { value });
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        title={copied ? t("common.copied") : value}
        className="lj-hash lj-hash--copy"
        aria-label={copyLabel}
      >
        <span aria-hidden="true">{copied ? t("common.copied").toLowerCase() : display}</span>
      </button>
      {/* Polite live region announces "Copied" exactly when the state
       * flips. Mounted alongside the button so each Hash gets its own
       * region (multiple visible Hashes can copy independently). */}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? t("common.copied") : ""}
      </span>
    </>
  );
}
