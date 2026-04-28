// Truncated hash / address display with click-to-copy.
//
// Cardano tx ids are 64-hex chars; bech32 addresses are ~100. Showing
// either in full is hostile to the eye. This component renders the
// first/last n characters with a middle ellipsis and copies the full
// value to the clipboard on click.

import { useState } from "react";

export interface HashProps {
  value: string;
  /** Characters to keep at each end. Default 6. */
  edge?: number;
  /** When set, click copies the full string to the clipboard. */
  copyable?: boolean;
}

export function Hash({ value, edge = 6, copyable = true }: HashProps) {
  const [copied, setCopied] = useState(false);
  const display =
    value.length <= edge * 2 + 1
      ? value
      : `${value.slice(0, edge)}…${value.slice(-edge)}`;
  if (!copyable) {
    return <span className="lj-hash" title={value}>{display}</span>;
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
  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "Copied" : value}
      className="lj-hash lj-hash--copy"
    >
      {copied ? "copied" : display}
    </button>
  );
}
