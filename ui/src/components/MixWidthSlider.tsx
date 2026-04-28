// N-width slider — picks the Mix tx's `N` (2 ≤ N ≤ max_n).
//
// Spec: docs/spec/06-ui.md §"Pool" + M6.5 — slider clamps to the runtime
// max_n (no hard-coded fallback). Default is the deployed cap so users
// get the strongest privacy gain by default; advanced users dial down.
//
// Edge case: when max_n == 2 there's nothing to slide between — the
// slider degenerates to a single value. We render a stat-style readout
// instead so the screen doesn't show a useless 1-position track.

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
  const segments = Array.from({ length: max - 1 }, (_, i) => i + 2);

  // No room to slide — just show the value.
  if (max === min) {
    return (
      <div className="flex items-baseline justify-between gap-6">
        <div className="lj-stat">
          <span className="lj-stat__label">{t("pool.mix_width")}</span>
          <span className="lj-stat__value" data-num>
            {min}
          </span>
        </div>
        <p className="max-w-md text-xs text-whisper leading-relaxed">
          {t("pool.width_help_fixed", { n: min })}
        </p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-3 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-baseline justify-between">
        <Eyebrow>{t("pool.mix_width")}</Eyebrow>
        <span className="font-mono text-3xl font-medium text-paper" data-num>
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
      <div className="flex justify-between text-xs text-whisper font-mono">
        <span>{t("pool.mix_width_min")}</span>
        <span>{t("pool.mix_width_max", { n: max })}</span>
      </div>
      <p className="text-xs text-whisper leading-relaxed">
        {t("pool.width_help", { n: safeValue, cap: max })}
      </p>
    </div>
  );
}
