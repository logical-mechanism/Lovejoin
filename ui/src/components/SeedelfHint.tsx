// Seedelf-aware destination-address hint for the Withdraw screen.
//
// Spec: docs/spec/06-ui.md §"Withdraw" — signal-toned banner when the
// destination is a stealth (script) address, amber when it's a regular
// key address.

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
      <div className="lj-banner lj-banner--signal mt-2">
        <span className="lj-banner__title">{t("withdraw.seedelf_detected")}</span>
      </div>
    );
  }
  if (classification.kind === "regular-key") {
    return (
      <div className="lj-banner lj-banner--amber mt-2">
        <span className="lj-banner__title">{t("withdraw.seedelf_hint")}</span>
      </div>
    );
  }
  return null;
}
