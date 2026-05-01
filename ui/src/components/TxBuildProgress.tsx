// In-flight tx progress — phase ticker + animated bar.
//
// Replaces the bare full-screen spinner used during deposit / mix /
// withdraw submission. The SDK builders are single async calls without
// per-phase callbacks, so the component scripts the phase advance from
// per-phase wall-clock estimates: while the promise is in flight the bar
// asymptotes toward 92 % and the active step pulses; when the promise
// resolves (active flips to false) the bar snaps to 100 %, every step
// marks done, and the indicator unmounts after a short victory hold.
//
// Reduced-motion: the pulse + shimmer are disabled in tailwind.css; the
// bar still updates discretely so progress is still legible.

import { useEffect, useRef, useState } from "react";

export interface TxBuildPhase {
  /** Already-translated label shown next to the dot. */
  label: string;
  /** Typical wall-clock duration of this phase, in ms. */
  estimateMs: number;
}

export interface TxBuildProgressProps {
  /** Whether the underlying op is in flight. False triggers the finish animation. */
  active: boolean;
  /** Ordered phases. Earlier phases are marked done as time accrues. */
  phases: ReadonlyArray<TxBuildPhase>;
  /** Localized accessible label for screen readers (e.g. "Building deposit…"). */
  ariaLabel: string;
}

const FINISH_HOLD_MS = 600;
const ASYMPTOTE = 0.92;

export function TxBuildProgress({ active, phases, ariaLabel }: TxBuildProgressProps) {
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const startedAt = useRef<number | null>(null);
  const wasActive = useRef(false);
  const totalEstimate = phases.reduce((s, p) => s + p.estimateMs, 0) || 1;

  // Mount/unmount + finish-snap state machine, driven off `active`.
  useEffect(() => {
    if (active && !wasActive.current) {
      wasActive.current = true;
      setVisible(true);
      setFinishing(false);
      setProgress(0);
      setPhaseIdx(0);
      startedAt.current = performance.now();
      return;
    }
    if (!active && wasActive.current) {
      wasActive.current = false;
      setFinishing(true);
      setProgress(1);
      setPhaseIdx(phases.length);
      const t = window.setTimeout(() => setVisible(false), FINISH_HOLD_MS);
      return () => window.clearTimeout(t);
    }
  }, [active, phases.length]);

  // Animation loop — runs only while active and not yet finishing.
  useEffect(() => {
    if (!active || finishing) return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const elapsed = now - (startedAt.current ?? now);
      let acc = 0;
      let idx = phases.length - 1;
      for (let i = 0; i < phases.length; i++) {
        acc += phases[i]!.estimateMs;
        if (elapsed < acc) {
          idx = i;
          break;
        }
      }
      setPhaseIdx(idx);
      // Exponential approach to 1, capped at ASYMPTOTE so the bar never
      // hits the end before the real op completes. The factor is tuned so
      // the bar reaches ~80 % when elapsed == totalEstimate.
      const eased = 1 - Math.exp(-(elapsed / totalEstimate) * 1.6);
      setProgress(Math.min(ASYMPTOTE, eased));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, finishing, phases, totalEstimate]);

  if (!visible) return null;

  return (
    <div className="lj-tx-progress" role="status" aria-live="polite" aria-label={ariaLabel}>
      <ol className="lj-tx-progress__steps">
        {phases.map((p, i) => {
          const state = finishing || i < phaseIdx ? "done" : i === phaseIdx ? "active" : "pending";
          return (
            <li key={i} className={`lj-tx-progress__step lj-tx-progress__step--${state}`}>
              <span className="lj-tx-progress__dot" aria-hidden="true" />
              <span className="lj-tx-progress__label">{p.label}</span>
            </li>
          );
        })}
      </ol>
      <div className="lj-tx-progress__bar" aria-hidden="true">
        <div
          className={`lj-tx-progress__bar-fill${finishing ? " lj-tx-progress__bar-fill--done" : ""}`}
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}
