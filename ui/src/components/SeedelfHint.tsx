// Seedelf-aware destination-address hint for the Withdraw screen.
//
// Spec: docs/spec/06-ui.md §"Withdraw" — green when the destination is a
// stealth (script) address, yellow otherwise.

import { useTranslation } from "react-i18next";

import { classifyAddress } from "../lib/seedelf.js";

export interface SeedelfHintProps {
  address: string;
}

export function SeedelfHint({ address }: SeedelfHintProps) {
  const { t } = useTranslation();
  const classification = classifyAddress(address);
  if (classification.kind === "stealth") {
    return (
      <p className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">
        {t("withdraw.seedelf_detected")}
      </p>
    );
  }
  if (classification.kind === "regular-key") {
    return (
      <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
        {t("withdraw.seedelf_hint")}
      </p>
    );
  }
  // unknown / empty: no hint at all — the form's own validation will catch it.
  return null;
}
