// Password-recovery unlock — the wallet-bound, persistence-free fallback
// for wallets that don't expose signData and as a cross-device recovery
// path. Same wallet + same password (and same network) on any browser =
// same seed = same boxes.
//
// Nothing here writes to disk. The Argon2id step happens inside
// `unlockWithPassword` (lib/store.tsx → lib/vault.ts), bound to the
// connected wallet's stake address via `recoverySalt`. Locking the vault
// drops the seed; re-unlocking re-runs the same Argon2id derivation.
//
// UX:
//   * One password field, type=password, autocomplete="off".
//   * Real-time strength estimate driven by length + character classes.
//     Submit is enabled at "fair" or above; the SDK's
//     RECOVERY_PASSWORD_MIN_LENGTH cuts a hard floor below "fair".
//   * Clear "this is the entire security barrier" hint above the field.
//   * Inline spinner during the ~2 s Argon2id derivation; the parent
//     screen flips to the unlocked vault on resolution.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { RECOVERY_PASSWORD_MIN_LENGTH } from "@lovejoin/sdk";

import { Eyebrow } from "./ui/Eyebrow.js";
import { useAppState } from "../lib/store.js";

export interface RecoverPasswordPanelProps {
  onClose: () => void;
}

type Strength = "weak" | "fair" | "strong";

interface StrengthAssessment {
  strength: Strength;
  /** Estimated bits of entropy — used to pick the meter colour band. */
  bits: number;
  /** i18n key for the user-facing label under the input. */
  labelKey: string;
}

export function RecoverPasswordPanel({ onClose }: RecoverPasswordPanelProps) {
  const { t } = useTranslation();
  const { wallet, vaultBusy, vaultError, unlockWithPassword } = useAppState();
  const [password, setPassword] = useState("");

  const assessment = useMemo<StrengthAssessment>(
    () => assessStrength(password),
    [password],
  );

  // Submit gates: a wallet must be connected (its stake address goes
  // into the salt), the password must clear the "fair" bar, and we
  // can't be mid-derivation. RECOVERY_PASSWORD_MIN_LENGTH is the SDK's
  // hard floor — the strength meter typically rejects passwords well
  // before they hit it, but we still gate explicitly so a user pasting
  // a short string sees the same disabled state the meter implies.
  const canSubmit =
    !!wallet &&
    !vaultBusy &&
    password.length >= RECOVERY_PASSWORD_MIN_LENGTH &&
    assessment.strength !== "weak";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      await unlockWithPassword(password);
      onClose();
    } catch {
      // store.tsx already populated vaultError — leave the panel open so
      // the user can correct the password without losing what they typed.
    }
  };

  return (
    <section className="lj-card">
      <header className="lj-card__head">
        <div>
          <Eyebrow>{t("vault.recover_eyebrow")}</Eyebrow>
          <h2 className="lj-card__title">{t("vault.recover_title")}</h2>
        </div>
        <button
          type="button"
          className="lj-btn lj-btn--quiet"
          onClick={onClose}
          disabled={vaultBusy}
        >
          {t("common.back")}
        </button>
      </header>

      <p className="text-sm text-muted leading-relaxed max-w-prose">
        {t("vault.recover_lede")}
      </p>

      <div className="lj-banner lj-banner--amber mt-5">
        <span className="lj-banner__title">
          {t("vault.recover_warning_title")}
        </span>
        <span className="lj-banner__detail">
          {t("vault.recover_warning_detail", {
            min: RECOVERY_PASSWORD_MIN_LENGTH,
          })}
        </span>
      </div>

      <form className="mt-6 flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)}>
        <div className="lj-field">
          <label className="lj-field__label" htmlFor="recover-password">
            {t("vault.recover_password_label")}
          </label>
          <input
            id="recover-password"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="lj-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={vaultBusy}
            autoFocus
            aria-describedby="recover-password-strength recover-password-hint"
          />
          <StrengthMeter password={password} assessment={assessment} />
          <span id="recover-password-hint" className="lj-field__hint">
            {t("vault.recover_password_hint", {
              min: RECOVERY_PASSWORD_MIN_LENGTH,
            })}
          </span>
        </div>

        <button
          type="submit"
          className="lj-btn lj-btn--primary lj-btn--lg self-start"
          disabled={!canSubmit}
        >
          {vaultBusy && (
            <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />
          )}
          {vaultBusy ? t("vault.recover_unlocking") : t("vault.recover_unlock")}
        </button>

        {!wallet && (
          <p className="text-sm text-whisper">{t("vault.no_wallet")}</p>
        )}

        {vaultError && (
          <div className="lj-banner lj-banner--coral">
            <span className="lj-banner__title">
              {t("vault.unlock_failed", { message: vaultError })}
            </span>
          </div>
        )}
      </form>
    </section>
  );
}

function StrengthMeter({
  password,
  assessment,
}: {
  password: string;
  assessment: StrengthAssessment;
}) {
  const { t } = useTranslation();
  // 4-segment meter: weak fills 1, fair fills 2, strong fills 4.
  const lit =
    assessment.strength === "weak"
      ? 1
      : assessment.strength === "fair"
        ? 2
        : 4;
  // Render the live region unconditionally — even when empty — so the
  // wired aria-describedby on the input always resolves. We only render
  // the visible UI when the user has typed something.
  return (
    <div
      id="recover-password-strength"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {password.length > 0 && (
        <div className="flex items-center gap-3">
          <div
            className="lj-meter mt-0 flex-1"
            aria-hidden="true"
          >
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={
                  "lj-meter__seg" + (i < lit ? " lj-meter__seg--lit" : "")
                }
              />
            ))}
          </div>
          <span
            className={`text-xs font-mono uppercase tracking-wider ${
              assessment.strength === "strong"
                ? "text-paper"
                : assessment.strength === "fair"
                  ? "text-amber"
                  : "text-coral"
            }`}
          >
            {/* AT users hear "Password strength: Strong" rather than just
             * "Strong" so the reading is unambiguous in context. */}
            <span className="sr-only">
              {t("vault.recover_strength_announce_prefix")}
            </span>
            {t(assessment.labelKey)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Cheap entropy estimator. Length × log2(charset size) is the textbook
 * approximation; we give partial credit for mixed character classes so
 * a 12-char all-lowercase password ranks below a 12-char mixed one even
 * though both share a length bound.
 *
 * Calibration:
 *   - "weak"   : < 50 bits — the unlock button stays disabled.
 *   - "fair"   : 50–69 bits — submit allowed but meter shows amber.
 *   - "strong" : ≥ 70 bits — full meter, paper colour.
 *
 * 50 bits corresponds to ~7.5 random ASCII printable chars or a
 * 4-word EFF-style passphrase. The Argon2id wall sits at 4 iterations
 * × 256 MiB; 50 bits + that wall is still in the "infeasible to brute-
 * force a single targeted user" zone for non-state-actor adversaries.
 */
function assessStrength(password: string): StrengthAssessment {
  if (password.length === 0) {
    return { strength: "weak", bits: 0, labelKey: "vault.recover_strength_weak" };
  }
  let charset = 0;
  if (/[a-z]/.test(password)) charset += 26;
  if (/[A-Z]/.test(password)) charset += 26;
  if (/[0-9]/.test(password)) charset += 10;
  if (/[^a-zA-Z0-9]/.test(password)) charset += 32;
  if (charset === 0) charset = 1;
  const bits = password.length * Math.log2(charset);
  if (bits < 50) {
    return { strength: "weak", bits, labelKey: "vault.recover_strength_weak" };
  }
  if (bits < 70) {
    return { strength: "fair", bits, labelKey: "vault.recover_strength_fair" };
  }
  return { strength: "strong", bits, labelKey: "vault.recover_strength_strong" };
}
