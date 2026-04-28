// N-width slider — picks the Mix tx's `N` (2 ≤ N ≤ max_n).
//
// Spec: docs/spec/06-ui.md §"Pool" + M6.5 — slider clamps to the runtime
// max_n (no hard-coded fallback). The cap is read from the addresses
// bundle's `protocol.max_n` so the deployed reality wins over a stale
// constant.

import { useTranslation } from "react-i18next";

import { Eyebrow } from "./ui/Eyebrow.js";

export interface MixWidthSliderProps {
  value: number;
  maxN: number;
  onChange: (next: number) => void;
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
  // Privacy meter: lit segments correspond to selected width — pure
  // visual aid, no semantic weight.
  const segments = Array.from({ length: max - 1 }, (_, i) => i + 2);

  return (
    <div className={`flex flex-col gap-3 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-baseline justify-between">
        <Eyebrow>{t("pool.mix_width")}</Eyebrow>
        <span className="font-display text-3xl font-light text-paper" data-num>
          {safeValue}
        </span>
      </div>
      <input
        id="mix-width-slider"
        type="range"
        min={min}
        max={max}
        step={1}
        value={safeValue}
        disabled={disabled}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
        className="lj-slider"
        aria-label={t("pool.mix_width")}
      />
      <div className="lj-meter" aria-hidden>
        {segments.map((seg) => (
          <span
            key={seg}
            className={
              "lj-meter__seg" + (seg <= safeValue ? " lj-meter__seg--lit" : "")
            }
          />
        ))}
      </div>
      <div className="flex justify-between text-xs text-whisper">
        <span>{t("pool.mix_width_min")}</span>
        <span>{t("pool.mix_width_max", { n: max })}</span>
      </div>
      <p className="text-xs text-whisper leading-relaxed">
        {t("pool.width_help", { n: safeValue, cap: max })}
      </p>
    </div>
  );
}
