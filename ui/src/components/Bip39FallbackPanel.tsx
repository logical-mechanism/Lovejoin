// Tier-2 BIP-39 fallback flow.
//
// Spec: docs/spec/06-ui.md M6.5 — "for hardware wallets that don't expose
// signData and for users who want a Lovejoin identity independent of any
// specific wallet, an opt-in BIP-39 mnemonic flow. 24-word English
// wordlist, shown in a save-NOW modal with confirm-by-retyping-3-random-
// words gate, encrypted in IndexedDB under an Argon2id-derived key from a
// passphrase."
//
// State machine:
//   passphrase → unlock attempt
//                ├─ vault exists + entropy stored → emit seed (handled in
//                │  store.tsx); panel closes itself.
//                ├─ vault exists, no entropy → "create" branch (rare,
//                │  user paused mid-create).
//                └─ vault didn't exist → "create" branch (auto-create on
//                   unlock with the typed passphrase).
//   create branch:
//     1. show 24 words (save-NOW)
//     2. confirm 3 random words
//     3. on confirm, putEntropyHex into the vault — store.tsx decrypts
//        the seed into memory.
//
// We deliberately keep all of this in one component so the user sees a
// single "stack" of steps rather than chasing modals.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { Eyebrow } from "./ui/Eyebrow.js";
import { useAppState } from "../lib/store.js";
import { EntropyVault } from "../storage/secrets.js";

type Step = "enter-passphrase" | "create-show" | "create-confirm" | "done";

export interface Bip39FallbackPanelProps {
  onClose: () => void;
}

export function Bip39FallbackPanel({ onClose }: Bip39FallbackPanelProps) {
  const { t } = useTranslation();
  const { vault, vaultBusy, vaultError, unlockWithPassphrase, storeEntropyHex } =
    useAppState();
  const [passphrase, setPassphrase] = useState("");
  const [step, setStep] = useState<Step>("enter-passphrase");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [confirmInputs, setConfirmInputs] = useState<Record<number, string>>({});
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Pick three random word indices to quiz the user on. Memoized on the
  // generated phrase so re-renders don't shuffle the question while the
  // user is typing.
  const quizIndices = useMemo(() => {
    if (!phrase) return [];
    const all = Array.from({ length: 24 }, (_, i) => i);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j]!, all[i]!];
    }
    return all.slice(0, 3).sort((a, b) => a - b);
  }, [phrase]);

  const onUnlock = async () => {
    setConfirmError(null);
    try {
      const exists = await EntropyVault.exists();
      const result = await unlockWithPassphrase(passphrase);
      if (result.hasEntropy) {
        // store.tsx is now holding the seed; the parent screen will
        // re-render with `vault.kind === "bip39"` and pop us out.
        setStep("done");
        onClose();
        return;
      }
      // Either fresh vault or paused-mid-create → enter the create flow.
      const fresh = exists ? "" : generateMnemonic(wordlist, 256);
      const newPhrase = fresh || generateMnemonic(wordlist, 256);
      setPhrase(newPhrase);
      setStep("create-show");
    } catch {
      // store.tsx already populated vaultError — nothing more to do here.
    }
  };

  const onConfirm = async () => {
    if (!phrase) return;
    const words = phrase.split(" ");
    const ok = quizIndices.every(
      (idx) => (confirmInputs[idx] ?? "").trim().toLowerCase() === words[idx],
    );
    if (!ok) {
      setConfirmError(t("vault.fallback_confirm_failed"));
      return;
    }
    const entropy = mnemonicToEntropy(phrase, wordlist);
    const entropyHex = bytesToHex(entropy);
    await storeEntropyHex(entropyHex);
    setStep("done");
    onClose();
  };

  if (step === "enter-passphrase") {
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("vault.fallback_title")}</Eyebrow>
            <h2 className="lj-card__title">{t("vault.fallback_unlock")}</h2>
          </div>
          <button type="button" className="lj-btn lj-btn--quiet" onClick={onClose}>
            {t("vault.fallback_back")}
          </button>
        </header>
        <p className="text-sm text-muted max-w-prose">{t("vault.fallback_lede")}</p>
        <form
          className="mt-6 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void onUnlock();
          }}
        >
          <label className="lj-field">
            <span className="lj-field__label">{t("vault.fallback_passphrase")}</span>
            <input
              type="password"
              autoComplete="off"
              className="lj-input"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoFocus
            />
          </label>
          <button
            type="submit"
            className="lj-btn lj-btn--primary self-start"
            disabled={vaultBusy || passphrase.length < 6}
          >
            {vaultBusy ? t("vault.fallback_unlocking") : t("vault.fallback_unlock")}
          </button>
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

  if (step === "create-show" && phrase) {
    const words = phrase.split(" ");
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("vault.fallback_title")}</Eyebrow>
            <h2 className="lj-card__title">{t("vault.fallback_save_now_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-amber max-w-prose">
          {t("vault.fallback_save_now_copy")}
        </p>
        <ol className="mt-6 grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
          {words.map((word, i) => (
            <li
              key={i}
              className="flex items-baseline gap-3 border-b border-rule pb-2"
            >
              <span className="lj-eyebrow w-6 shrink-0 text-right">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="font-mono text-paper">{word}</span>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="lj-btn"
            onClick={() => setStep("create-confirm")}
          >
            {t("vault.fallback_save_done")}
          </button>
        </div>
      </section>
    );
  }

  if (step === "create-confirm" && phrase) {
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("vault.fallback_title")}</Eyebrow>
            <h2 className="lj-card__title">{t("vault.fallback_confirm_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted">
          {t("vault.fallback_confirm_lede", {
            a: quizIndices[0]! + 1,
            b: quizIndices[1]! + 1,
            c: quizIndices[2]! + 1,
          })}
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {quizIndices.map((idx) => (
            <label key={idx} className="lj-field">
              <span className="lj-field__label">
                {t("vault.fallback_confirm_word", { n: idx + 1 })}
              </span>
              <input
                type="text"
                className="lj-input"
                value={confirmInputs[idx] ?? ""}
                onChange={(e) =>
                  setConfirmInputs((cur) => ({ ...cur, [idx]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>
        {confirmError && (
          <div className="lj-banner lj-banner--coral mt-4">
            <span className="lj-banner__title">{confirmError}</span>
          </div>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setStep("create-show")}
          >
            {t("common.back")}
          </button>
          <button
            type="button"
            className="lj-btn lj-btn--primary"
            disabled={vaultBusy}
            onClick={() => void onConfirm()}
          >
            {t("vault.fallback_confirm_button")}
          </button>
        </div>
      </section>
    );
  }

  // Done — store.tsx now holds the seed and the parent screen renders the
  // unlocked Vault. We unmount via onClose() above; this branch never shows.
  if (vault?.kind === "bip39" && vault.seed.length > 0) return null;
  return null;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// Avoid the lint warning that the default-import for entropyToMnemonic is unused.
void entropyToMnemonic;
