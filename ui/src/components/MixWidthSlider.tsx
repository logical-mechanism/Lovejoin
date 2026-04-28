// N-width slider — picks the Mix tx's `N` (2 ≤ N ≤ max_n).
//
// Spec: docs/spec/06-ui.md §"Pool" — "The MixWidthSlider lets the user
// choose N (range 2..max_n); default max. Higher N = better privacy gain
// per round but larger tx."
//
// `max_n` comes from the protocol calibration committed in
// `config/network.preprod.json` and surfaced via the LovejoinAddresses or
// the network-config asset. We accept it as a prop so the Pool screen owns
// the source-of-truth lookup.

import { useTranslation } from "react-i18next";

export interface MixWidthSliderProps {
  value: number;
  maxN: number;
  onChange: (next: number) => void;
  /** When true, disable the input + grey-out the label. */
  disabled?: boolean;
}

export function MixWidthSlider({
  value,
  maxN,
  onChange,
  disabled = false,
}: MixWidthSliderProps) {
  const { t } = useTranslation();
  const min = 2;
  const max = Math.max(min, maxN);
  const safeValue = Math.max(min, Math.min(max, value));
  return (
    <div className={`flex flex-col gap-1 ${disabled ? "opacity-50" : ""}`}>
      <label
        htmlFor="mix-width-slider"
        className="flex items-center justify-between text-sm font-medium"
      >
        <span>{t("pool.mix_width")}</span>
        <span className="font-mono">N = {safeValue}</span>
      </label>
      <input
        id="mix-width-slider"
        type="range"
        min={min}
        max={max}
        step={1}
        value={safeValue}
        disabled={disabled}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
        className="w-full"
      />
      <div className="flex justify-between text-[10px] text-gray-500">
        <span>{t("pool.mix_width_min")}</span>
        <span>{t("pool.mix_width_max", { n: max })}</span>
      </div>
    </div>
  );
}
